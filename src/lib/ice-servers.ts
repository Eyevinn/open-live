import { StromClient, type IceServer } from './strom.js';
import { getStromToken } from './strom-token.js';
import { config } from '../config.js';

/**
 * Strom's ICE server list (STROM_SERVER_ICE_SERVERS) in RTCIceServer shape,
 * shared by GET /api/v1/ice-servers (crew) and the guest join response (the
 * guest page), so every browser gets the same STUN/TURN servers.
 *
 * Stale-on-error: serves the last successful list when Strom is temporarily
 * unreachable (e.g. brief DNS failure after a network reconnect). ICE server
 * config changes rarely so a stale list is far better than none. The cache is
 * dropped after 5 minutes so expired TURN credentials are not served
 * indefinitely. Throws when Strom fails and nothing is cached.
 *
 * A caller that must not wait passes `timeoutMs`: the guest join does, so a
 * hung Strom cannot hold a guest on "Connecting…". The deadline covers the
 * token exchange and the Strom call. Without it the lookup waits as long as
 * Strom and the token service take.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedIceServers: IceServer[] | null = null;
let cacheTimestamp = 0;

/**
 * Clear the module-level stale-on-error cache.
 *
 * The cache is module-scoped so it survives across `buildServer()` instances —
 * that is correct in production (the last-good ICE config should outlive a
 * server rebuild) but leaks state between tests, where each test builds a fresh
 * server yet shares this module. Tests call this in `beforeEach` so a cached
 * success from an earlier test can't mask a later error expectation.
 */
export function resetIceServersCache(): void {
  cachedIceServers = null;
  cacheTimestamp = 0;
}

/** The Strom token; undefined when there is none or the exchange fails. */
function stromToken(): Promise<string | undefined> {
  return getStromToken(config.stromToken).catch(() => undefined);
}

/**
 * `work`, or a rejection once `ms` pass. The work is not aborted, only no
 * longer waited for: the token exchange is shared with every other caller
 * (getStromToken coalesces them), and the Strom call aborts itself on its own
 * per-attempt timeout.
 */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No ${what} within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The list, and the error when it is the cached one served because Strom failed. */
export async function getIceServers(
  { timeoutMs }: { timeoutMs?: number } = {},
): Promise<{ iceServers: IceServer[]; stale?: Error }> {
  if (Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    cachedIceServers = null;
  }
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  try {
    // A Strom that needs the token cannot answer without it, so a token that
    // misses the deadline fails the lookup rather than asking Strom anyway.
    const token = deadline === undefined
      ? await stromToken()
      : await within(stromToken(), timeoutMs!, 'Strom token');
    const strom = new StromClient({ baseUrl: config.stromUrl, token });
    // StromClient retries a dropped socket once, each attempt with its own
    // timeout, so the deadline also bounds the call as a whole.
    const lookup = strom.system.iceServers(
      deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
    );
    const { ice_servers } = deadline === undefined
      ? await lookup
      : await within(lookup, Math.max(1, deadline - Date.now()), 'ICE servers');
    cachedIceServers = ice_servers;
    cacheTimestamp = Date.now();
    return { iceServers: ice_servers };
  } catch (err) {
    if (cachedIceServers) {
      return { iceServers: cachedIceServers, stale: err instanceof Error ? err : new Error(String(err)) };
    }
    throw err;
  }
}
