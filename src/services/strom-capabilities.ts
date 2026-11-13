/**
 * What Strom can do on the network it runs on, as Strom reports it
 * (`GET /api/capabilities`), cached: which SRT modes can work, which SRT
 * relays it can use (name and public `host:port`), whether its ports are
 * reachable from outside, and its port ranges.
 *
 * Open Live keeps none of this in its own config: Strom knows how it is
 * deployed and where its relays are, and resolves every `srt+relay://`
 * address itself. Open Live needs the relays' public addresses to show the
 * dial-in address (`srt://<public>?streamid=<id>`), the relay names to check
 * `@<relay>` and to let the studio offer a relay picker, and the SRT modes
 * so the studio offers only directions that work (#628). Modes are reported,
 * never enforced: the operator may know better.
 *
 * Requests never wait on Strom (stale-while-revalidate):
 * - The answer is fresh for 30 s. After that the cached answer is still served
 *   at once and one background request refreshes it.
 * - It is warmed at startup (`warmStromCapabilities`). Only a lookup with
 *   nothing cached at all (the very first one, if the warm-up has not
 *   finished) waits, and at most FIRST_WAIT_MS; past that it reads as
 *   `state: 'unknown'`.
 * - A 404 is an older Strom without capabilities: a definite answer,
 *   `state: 'unsupported'`, every mode offered as before and no relay.
 * - Any other failure (Strom down, timeout, bad token) keeps the last known
 *   values with `state: 'unreachable'` and the error, and is retried after
 *   5 s rather than every 30 s.
 *
 * Parsing fails open: a mode is unsupported only when Strom says exactly
 * `false`, and a malformed relay entry or port span is dropped.
 */

import { StromClient, StromClientError, type StromPortSpan, type StromRelayEndpoint } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { isSrtRelayAddress, isValidSrtRelayName } from '../lib/srt-relay.js';

/**
 * How current the answer is: `ok` when Strom answered the last request,
 * `unsupported` when Strom answered 404 (older Strom without capabilities),
 * `unreachable` when the last request failed (the values are then the last
 * known ones), `unknown` when Strom has not answered yet at all.
 */
export type StromCapabilitiesState = 'ok' | 'unsupported' | 'unreachable' | 'unknown';

export interface SrtModes {
  /** Strom binds a port and the outside party dials it. Needs inbound reachability. */
  listener: boolean;
  /** Strom dials the outside party. */
  caller: boolean;
  /** Both sides dial each other. Needs inbound reachability. */
  rendezvous: boolean;
}

export type SrtRelayEndpoint = StromRelayEndpoint;

export interface StromCapabilities {
  state: StromCapabilitiesState;
  /** Whether a port Strom binds can be reached from outside; null when not known. */
  inboundReachable: boolean | null;
  /** Strom's `STROM_PORTS` as inclusive spans, or null (any port, or not known). */
  ports: StromPortSpan[] | null;
  srt: {
    /** The SRT modes that can work. All true unless Strom said otherwise. */
    modes: SrtModes;
    /** The SRT relays Strom can use, `default` first. Empty when none (or not known). */
    relays: SrtRelayEndpoint[];
  };
  /** Why the last request failed (`unreachable` only), else null. */
  error: string | null;
}

const TTL_MS = 30_000;
const ERROR_TTL_MS = 5_000;
const TIMEOUT_MS = 3_000;
/** The longest a request waits when nothing is cached yet. */
const FIRST_WAIT_MS = 3_000;

const ALL_MODES: SrtModes = { listener: true, caller: true, rendezvous: true };

function noAnswer(state: 'unsupported' | 'unknown'): StromCapabilities {
  return { state, inboundReachable: null, ports: null, srt: { modes: { ...ALL_MODES }, relays: [] }, error: null };
}

let cached: { value: StromCapabilities; expiresAt: number } | null = null;
let inflight: Promise<StromCapabilities> | null = null;

/** Test-only: forget every cached answer. */
export function resetStromCapabilitiesCache(): void {
  cached = null;
  inflight = null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function normalisePorts(v: unknown): StromPortSpan[] | null {
  if (!Array.isArray(v)) return null;
  const isPort = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 65535;
  return v.flatMap((span) =>
    isObject(span) && isPort(span['first']) && isPort(span['last']) && span['first'] <= span['last']
      ? [{ first: span['first'], last: span['last'] }]
      : [],
  );
}

function normaliseRelays(v: unknown): SrtRelayEndpoint[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const relays: SrtRelayEndpoint[] = [];
  for (const r of v) {
    if (!isObject(r)) continue;
    const name = typeof r['name'] === 'string' ? r['name'] : '';
    const pub = typeof r['public'] === 'string' ? r['public'].trim() : '';
    if (!isValidSrtRelayName(name) || !pub || seen.has(name)) continue;
    seen.add(name);
    relays.push({ name, public: pub });
  }
  return relays;
}

/** Strom's `GET /api/capabilities` body as Open Live uses it (`state: 'ok'`). */
export function normaliseCapabilities(body: unknown): StromCapabilities {
  const root = isObject(body) ? body : {};
  const network = isObject(root['network']) ? root['network'] : {};
  const protocols = isObject(root['protocols']) ? root['protocols'] : {};
  const srt = isObject(protocols['srt']) ? protocols['srt'] : {};
  const modes = isObject(srt['modes']) ? srt['modes'] : {};
  return {
    state: 'ok',
    inboundReachable: typeof network['inbound_reachable'] === 'boolean' ? network['inbound_reachable'] : null,
    ports: normalisePorts(network['ports']),
    srt: {
      modes: {
        listener: modes['listener'] !== false,
        caller: modes['caller'] !== false,
        rendezvous: modes['rendezvous'] !== false,
      },
      relays: normaliseRelays(srt['relays']),
    },
    error: null,
  };
}

async function lookup(): Promise<StromCapabilities> {
  let value: StromCapabilities;
  let ttl = TTL_MS;
  try {
    const token = await getStromToken(config.stromToken).catch(() => undefined);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: token ?? undefined });
    value = normaliseCapabilities(await strom.system.capabilities(TIMEOUT_MS));
  } catch (err) {
    if (err instanceof StromClientError && err.status === 404) {
      value = noAnswer('unsupported');
    } else {
      const last = cached?.value ?? noAnswer('unknown');
      value = {
        ...last,
        state: 'unreachable',
        error: `Could not read Strom's capabilities: ${err instanceof Error ? err.message : String(err)}`,
      };
      ttl = ERROR_TTL_MS;
    }
  }
  cached = { value, expiresAt: Date.now() + ttl };
  return value;
}

function refresh(): Promise<StromCapabilities> {
  inflight ??= lookup().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Strom's capabilities. Never throws, and never waits on Strom when an answer
 * is cached (a stale one is served while a refresh runs behind it).
 */
export function getStromCapabilities(): Promise<StromCapabilities> {
  if (cached) {
    if (Date.now() >= cached.expiresAt) void refresh();
    return Promise.resolve(cached.value);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<StromCapabilities>((resolve) => {
    timer = setTimeout(() => resolve(noAnswer('unknown')), FIRST_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([refresh(), timeout]).finally(() => clearTimeout(timer));
}

/** Start the first lookup without waiting for it (called at startup). */
export function warmStromCapabilities(): void {
  if (!cached) void refresh();
}

/**
 * Strom's capabilities for resolving the dial-in address of these SRT
 * addresses, or undefined when there are none (so a page without SRT never
 * waits on Strom). Relay addresses need the relays, listener and rendezvous
 * addresses the modes.
 */
export async function srtCapabilitiesFor(
  addresses: ReadonlyArray<string | undefined | null>,
): Promise<StromCapabilities | undefined> {
  const srt = (a: string | undefined | null) => typeof a === 'string' && (isSrtRelayAddress(a) || a.trim().startsWith('srt://'));
  if (!addresses.some(srt)) return undefined;
  return getStromCapabilities();
}
