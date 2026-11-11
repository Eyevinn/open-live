/**
 * The SRT relay Strom fronts, as Strom reports it (GET /api/srt-relay), cached.
 *
 * Open Live does not know where the relay is: Strom does, and resolves every
 * `srt+relay://<id>` address itself. Open Live only needs the relay's public
 * `host:port` to show the dial-in address (`srt://<public>?streamid=<id>`),
 * and whether a relay exists at all (`server-info.srtRelay.configured`, which
 * the studio uses to offer the "via relay" choice).
 *
 * - Cached for 30 s; concurrent lookups share one request.
 * - A 404 (Strom without relay support) reads as "not configured" and is
 *   cached like any answer.
 * - Any other failure (Strom down, timeout, bad token) serves the last good
 *   answer for up to 5 min; with none, it reads as not configured, with the
 *   error, and is retried after 5 s rather than on every request.
 */

import { StromClient, StromClientError, type SrtRelayStatusResponse } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { isSrtRelayAddress } from '../lib/srt-relay.js';

export type SrtRelayStatus = SrtRelayStatusResponse;

const TTL_MS = 30_000;
const ERROR_TTL_MS = 5_000;
const STALE_MAX_MS = 5 * 60_000;
const TIMEOUT_MS = 3_000;

const NOT_CONFIGURED: SrtRelayStatus = { configured: false, relay: null, public: null, error: null };

let cached: { value: SrtRelayStatus; expiresAt: number } | null = null;
let lastGood: { value: SrtRelayStatus; at: number } | null = null;
let inflight: Promise<SrtRelayStatus> | null = null;

/** Test-only: forget every cached answer. */
export function resetSrtRelayStatusCache(): void {
  cached = null;
  lastGood = null;
  inflight = null;
}

function normalise(body: Partial<SrtRelayStatusResponse> | undefined): SrtRelayStatus {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    configured: body?.configured === true,
    relay: str(body?.relay),
    public: str(body?.public),
    error: str(body?.error),
  };
}

async function lookup(): Promise<SrtRelayStatus> {
  const now = Date.now();
  try {
    const token = await getStromToken(config.stromToken).catch(() => undefined);
    const strom = new StromClient({ baseUrl: config.stromUrl, token: token ?? undefined });
    const value = normalise(await strom.system.srtRelay(TIMEOUT_MS));
    cached = { value, expiresAt: now + TTL_MS };
    lastGood = { value, at: now };
    return value;
  } catch (err) {
    if (err instanceof StromClientError && err.status === 404) {
      cached = { value: NOT_CONFIGURED, expiresAt: now + TTL_MS };
      lastGood = { value: NOT_CONFIGURED, at: now };
      return NOT_CONFIGURED;
    }
    if (lastGood && now - lastGood.at <= STALE_MAX_MS) {
      cached = { value: lastGood.value, expiresAt: now + ERROR_TTL_MS };
      return lastGood.value;
    }
    const value: SrtRelayStatus = {
      ...NOT_CONFIGURED,
      error: `Could not read the SRT relay status from Strom: ${err instanceof Error ? err.message : String(err)}`,
    };
    cached = { value, expiresAt: now + ERROR_TTL_MS };
    return value;
  }
}

/** Strom's SRT relay status. Never throws. */
export function getSrtRelayStatus(): Promise<SrtRelayStatus> {
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value);
  inflight ??= lookup().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * The relay info needed to resolve the dial-in address of these addresses, or
 * undefined when none of them is a relay address (so listing plain SRT docs
 * never waits on Strom).
 */
export async function srtRelayInfoFor(
  addresses: ReadonlyArray<string | undefined | null>,
): Promise<{ configured: boolean; public: string | null } | undefined> {
  if (!addresses.some((a) => isSrtRelayAddress(a))) return undefined;
  const status = await getSrtRelayStatus();
  return { configured: status.configured, public: status.public };
}
