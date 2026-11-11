/**
 * The SRT relay Strom fronts, as Strom reports it (GET /api/srt-relay), cached.
 *
 * Open Live does not know where the relay is: Strom does, and resolves every
 * `srt+relay://<id>` address itself. Open Live only needs the relay's public
 * `host:port` to show the dial-in address (`srt://<public>?streamid=<id>`),
 * and whether a relay exists at all (`server-info.srtRelay.configured`, which
 * the studio uses to offer the "via relay" choice).
 *
 * Requests never wait on Strom (stale-while-revalidate):
 * - The answer is fresh for 30 s. After that the cached answer is still served
 *   at once and one background request refreshes it.
 * - It is warmed at startup (`warmSrtRelayStatus`). Only a lookup with nothing
 *   cached at all (the very first one, if the warm-up has not finished) waits,
 *   and at most FIRST_WAIT_MS; past that it reads as `state: 'unknown'`.
 * - A 404 (Strom without relay support) is a definite answer: not configured.
 * - Any other failure (Strom down, timeout, bad token) keeps `configured` and
 *   `public` as last known, with `state: 'unreachable'` and the error, and is
 *   retried after 5 s rather than every 30 s.
 */

import { StromClient, StromClientError, type SrtRelayStatusResponse } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { isSrtRelayAddress } from '../lib/srt-relay.js';
import type { SrtRelayInfo } from '../lib/srt-connect.js';

/**
 * How current the answer is: `ok` when Strom answered the last request,
 * `unreachable` when it failed (configured/public are then the last known
 * values), `unknown` when Strom has not answered yet at all.
 */
export type SrtRelayState = 'ok' | 'unreachable' | 'unknown';

export interface SrtRelayStatus extends SrtRelayStatusResponse {
  state: SrtRelayState;
}

const TTL_MS = 30_000;
const ERROR_TTL_MS = 5_000;
const TIMEOUT_MS = 3_000;
/** The longest a request waits when nothing is cached yet. */
const FIRST_WAIT_MS = 3_000;

const UNKNOWN: SrtRelayStatus = { configured: false, relay: null, public: null, error: null, state: 'unknown' };

let cached: { value: SrtRelayStatus; expiresAt: number } | null = null;
let inflight: Promise<SrtRelayStatus> | null = null;

/** Test-only: forget every cached answer. */
export function resetSrtRelayStatusCache(): void {
  cached = null;
  inflight = null;
}

function normalise(body: Partial<SrtRelayStatusResponse> | undefined): SrtRelayStatus {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    configured: body?.configured === true,
    relay: str(body?.relay),
    public: str(body?.public),
    error: str(body?.error),
    state: 'ok',
  };
}

async function lookup(): Promise<SrtRelayStatus> {
  let value: SrtRelayStatus;
  let ttl = TTL_MS;
  try {
    const token = await getStromToken(config.stromToken).catch(() => undefined);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: token ?? undefined });
    value = normalise(await strom.system.srtRelay(TIMEOUT_MS));
  } catch (err) {
    if (err instanceof StromClientError && err.status === 404) {
      value = { configured: false, relay: null, public: null, error: null, state: 'ok' };
    } else {
      const last = cached?.value ?? UNKNOWN;
      value = {
        configured: last.configured,
        relay: last.relay,
        public: last.public,
        error: `Could not read the SRT relay status from Strom: ${err instanceof Error ? err.message : String(err)}`,
        state: 'unreachable',
      };
      ttl = ERROR_TTL_MS;
    }
  }
  cached = { value, expiresAt: Date.now() + ttl };
  return value;
}

function refresh(): Promise<SrtRelayStatus> {
  inflight ??= lookup().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Strom's SRT relay status. Never throws, and never waits on Strom when an
 * answer is cached (a stale one is served while a refresh runs behind it).
 */
export function getSrtRelayStatus(): Promise<SrtRelayStatus> {
  if (cached) {
    if (Date.now() >= cached.expiresAt) void refresh();
    return Promise.resolve(cached.value);
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<SrtRelayStatus>((resolve) => {
    timer = setTimeout(() => resolve(UNKNOWN), FIRST_WAIT_MS);
    timer.unref?.();
  });
  return Promise.race([refresh(), timeout]).finally(() => clearTimeout(timer));
}

/** Start the first lookup without waiting for it (called at startup). */
export function warmSrtRelayStatus(): void {
  if (!cached) void refresh();
}

/**
 * The relay info needed to resolve the dial-in address of these addresses, or
 * undefined when none of them is a relay address (so listing plain SRT docs
 * never waits on Strom).
 */
export async function srtRelayInfoFor(addresses: ReadonlyArray<string | undefined | null>): Promise<SrtRelayInfo | undefined> {
  if (!addresses.some((a) => isSrtRelayAddress(a))) return undefined;
  const status = await getSrtRelayStatus();
  return { configured: status.configured, public: status.public, state: status.state };
}
