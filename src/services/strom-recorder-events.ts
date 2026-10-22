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

let factory: RecorderSocketFactory = defaultFactory;
const subscribers = new Set<RecorderEventSubscriber>();
/** Bumped on every connect and on shutdown, so a stale socket's callbacks are ignored. */
let generation = 0;
let closeSocket: (() => void) | undefined;
let connected = false;
let failedAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

/** Delay before reconnect attempt `n` (from 0): 1 s doubling to 30 s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
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
  };
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
      for (const sub of [...subscribers]) notifyConnected(sub);
    },
    onClose: () => {
      if (gen !== generation) return;
      connected = false;
      closeSocket = undefined;
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
}

/**
 * Subscribes to recorder events. Opens the shared socket for the first
 * subscriber; returns an unsubscribe function that closes it after the last.
 */
export function subscribeRecorderEvents(sub: RecorderEventSubscriber): () => void {
  subscribers.add(sub);
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
