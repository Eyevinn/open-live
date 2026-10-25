/**
 * Shared Strom recorder-event listener (issue #556).
 *
 * One Strom WebSocket, opened while at least one subscriber exists, carries
 * `RecorderFileChanged` for every recording production. Consumers subscribe
 * instead of opening a socket per production, so the live part upload and a
 * future per-input recording index (draft PR #411) can share it.
 *
 * The socket reconnects with exponential backoff while anyone is subscribed,
 * taking a fresh Strom token each time (in OSC mode the token is a short-lived
 * SAT). After every (re)connect each subscriber's `onConnected` runs, so it can
 * catch up on events it missed while the socket was down. Lifecycle is the
 * caller's: subscribe on activate, unsubscribe on deactivate and on production
 * delete (the same rule as issue #426).
 *
 * Part 0 of an activation opens as soon as the flow starts, before activation
 * reaches `active` and the live sessions subscribe (spec iso-input-recording.md
 * §6). So the socket keeps a short buffer of recent events, and a subscriber
 * that names a flow gets that flow's buffered events replayed first, with the
 * time open-live originally received them. Activation holds the socket open
 * from before `flows.start` ({@link holdRecorderEvents}) so those events are
 * received at all.
 */
import { config } from '../config.js';
import { StromClient, type FlowEvent } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';

/** A recorder opened `filename`: its first file, or the next after a split. */
export interface RecorderFileEvent {
  flowId: string;
  blockId: string;
  /** Strom media path, relative to the media root. */
  filename: string;
  /** The file's t=0 in UTC microseconds, when Strom reports it (Eyevinn/strom#944). */
  startUtcUs?: number;
  /** Wall-clock ms when open-live received the event; kept on a replay from the buffer. */
  receivedAtMs: number;
}

export interface RecorderEventSubscriber {
  onFileChanged(event: RecorderFileEvent): void;
  /**
   * Runs after every (re)connect of the shared socket, and at subscribe time
   * when the socket is already open. Events sent while it was down are lost.
   */
  onConnected?(): void;
}

/** Callbacks the socket factory wires to one connection attempt. */
export interface RecorderSocketHandlers {
  onEvent(event: FlowEvent): void;
  onOpen(): void;
  onClose(): void;
}

/**
 * Opens one Strom event socket. Resolves to a function that closes it. A
 * rejection, or `onClose` without `onOpen`, counts as a failed attempt.
 */
export type RecorderSocketFactory = (handlers: RecorderSocketHandlers) => Promise<() => void>;

const defaultFactory: RecorderSocketFactory = async (h) => {
  const strom = new StromClient({ baseUrl: config.stromUrl, token: await getStromToken(config.stromToken) });
  return strom.connectWebSocket(h.onEvent, h.onClose, h.onOpen);
};

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
/**
 * How long a received event stays in the replay buffer. Covers activation from
 * `flows.start` to `active`: the running-poll timeout (30 s) plus the
 * multiview lookup and the doc writes.
 */
export const RECENT_EVENT_TTL_MS = 120_000;
/** Most events the replay buffer keeps, over every flow. */
export const RECENT_EVENT_MAX = 1000;

let factory: RecorderSocketFactory = defaultFactory;
const subscribers = new Set<RecorderEventSubscriber>();
/** Bumped on every connect and on shutdown, so a stale socket's callbacks are ignored. */
let generation = 0;
let closeSocket: (() => void) | undefined;
let connected = false;
let failedAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** Recent events, oldest first, for replay to a new subscriber of the same flow. */
let recent: RecorderFileEvent[] = [];
/** Resolved on the next connect attempt's outcome (open or failure); see {@link holdRecorderEvents}. */
let attemptWaiters: Array<() => void> = [];

/** Delay before reconnect attempt `n` (from 0): 1 s doubling to 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

function settleAttemptWaiters(): void {
  const waiters = attemptWaiters;
  attemptWaiters = [];
  for (const w of waiters) w();
}

function pruneRecent(now: number): void {
  const firstFresh = recent.findIndex((e) => now - e.receivedAtMs <= RECENT_EVENT_TTL_MS);
  if (firstFresh < 0) recent = [];
  else if (firstFresh > 0) recent = recent.slice(firstFresh);
  if (recent.length > RECENT_EVENT_MAX) recent = recent.slice(recent.length - RECENT_EVENT_MAX);
}

function dispatch(event: FlowEvent): void {
  if (event.type !== 'RecorderFileChanged') return;
  const { flow_id, block_id, filename, start_utc_us } = event.data ?? ({} as Partial<typeof event.data>);
  if (typeof flow_id !== 'string' || typeof block_id !== 'string' || typeof filename !== 'string') return;
  const fileEvent: RecorderFileEvent = {
    flowId: flow_id,
    blockId: block_id,
    filename,
    ...(typeof start_utc_us === 'number' && Number.isFinite(start_utc_us) ? { startUtcUs: start_utc_us } : {}),
    receivedAtMs: Date.now(),
  };
  recent.push(fileEvent);
  pruneRecent(fileEvent.receivedAtMs);
  for (const sub of [...subscribers]) {
    try {
      sub.onFileChanged(fileEvent);
    } catch (err) {
      console.error('[strom-recorder-events] subscriber failed on RecorderFileChanged', err);
    }
  }
}

function notifyConnected(sub: RecorderEventSubscriber): void {
  try {
    sub.onConnected?.();
  } catch (err) {
    console.error('[strom-recorder-events] subscriber failed on connect', err);
  }
}

function scheduleReconnect(): void {
  if (subscribers.size === 0 || reconnectTimer) return;
  const delay = reconnectDelayMs(failedAttempts);
  failedAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
  reconnectTimer.unref?.();
}

function connect(): void {
  if (subscribers.size === 0) return;
  const gen = ++generation;
  connected = false;
  factory({
    onEvent: (event) => {
      if (gen === generation) dispatch(event);
    },
    onOpen: () => {
      if (gen !== generation) return;
      connected = true;
      failedAttempts = 0;
      settleAttemptWaiters();
      for (const sub of [...subscribers]) notifyConnected(sub);
    },
    onClose: () => {
      if (gen !== generation) return;
      connected = false;
      closeSocket = undefined;
      settleAttemptWaiters();
      scheduleReconnect();
    },
  }).then(
    (close) => {
      if (gen !== generation) {
        close();
        return;
      }
      closeSocket = close;
    },
    (err: unknown) => {
      if (gen !== generation) return;
      console.warn('[strom-recorder-events] cannot open the Strom event socket, retrying', err instanceof Error ? err.message : err);
      settleAttemptWaiters();
      scheduleReconnect();
    },
  );
}

function shutdown(): void {
  generation++;
  connected = false;
  failedAttempts = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const close = closeSocket;
  closeSocket = undefined;
  close?.();
  // Nothing is received while closed, so nothing older may be replayed later
  // as if it were recent.
  recent = [];
  settleAttemptWaiters();
}

export interface SubscribeOptions {
  /**
   * Replay this flow's buffered events to the subscriber first, in arrival
   * order and with their original `receivedAtMs`, before any live event.
   */
  replayFlowId?: string;
}

/**
 * Subscribes to recorder events. Opens the shared socket for the first
 * subscriber; returns an unsubscribe function that closes it after the last.
 */
export function subscribeRecorderEvents(sub: RecorderEventSubscriber, opts: SubscribeOptions = {}): () => void {
  subscribers.add(sub);
  if (opts.replayFlowId !== undefined) {
    pruneRecent(Date.now());
    for (const event of recent.filter((e) => e.flowId === opts.replayFlowId)) {
      try {
        sub.onFileChanged(event);
      } catch (err) {
        console.error('[strom-recorder-events] subscriber failed on a replayed RecorderFileChanged', err);
      }
    }
  }
  if (subscribers.size === 1 && !closeSocket && !reconnectTimer && !connected) {
    connect();
  } else if (connected) {
    notifyConnected(sub);
  }
  return () => {
    if (!subscribers.delete(sub)) return;
    if (subscribers.size === 0) shutdown();
  };
}

/** A hold on the shared socket, from {@link holdRecorderEvents}. */
export interface RecorderEventsHold {
  /**
   * Resolves once the socket is open, once the current connect attempt has
   * failed, or after `timeoutMs` — whichever comes first. Never rejects.
   */
  ready(timeoutMs: number): Promise<void>;
  /** Releases the hold; closes the socket when nobody else is subscribed. Idempotent. */
  release(): void;
}

/**
 * Keeps the shared socket open (and its replay buffer filling) without
 * consuming events. Activation takes a hold before `flows.start`, so the
 * events for part 0 are received and can be replayed to the live sessions it
 * starts once the flow is `active` (spec §6).
 */
export function holdRecorderEvents(): RecorderEventsHold {
  const release = subscribeRecorderEvents({ onFileChanged: () => {} });
  return {
    ready(timeoutMs: number): Promise<void> {
      if (connected || subscribers.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs);
        timer.unref?.();
        function done(): void {
          clearTimeout(timer);
          attemptWaiters = attemptWaiters.filter((w) => w !== done);
          resolve();
        }
        attemptWaiters.push(done);
      });
    },
    release,
  };
}

/** Number of current subscribers (for tests and diagnostics). */
export function recorderEventSubscriberCount(): number {
  return subscribers.size;
}

/** Replaces the socket factory; `undefined` restores the Strom one. Tests only. */
export function setRecorderSocketFactory(next: RecorderSocketFactory | undefined): void {
  factory = next ?? defaultFactory;
}

/** Drops every subscriber and closes the socket. Tests only. */
export function resetRecorderEvents(): void {
  subscribers.clear();
  shutdown();
}
