/**
 * OSC auth helpers — getStromToken / getOscServiceToken
 *
 * - STROM_AUTH_MODE=direct: returns the API key as-is (self-hosted Strom)
 * - STROM_AUTH_MODE=osc (default): exchanges the PAT for a short-lived SAT
 *   via the OSC token service (required for OSC-hosted Strom instances).
 *   Caches the SAT and refreshes it 5 min before expiry.
 * - getOscServiceToken(pat, serviceId): the same exchange for any OSC service
 *   (used by the intercom-manager client in `INTERCOM_MANAGER_AUTH_MODE=osc`).
 */

const TOKEN_EXCHANGE_URL = 'https://token.svc.prod.osaas.io/servicetoken'
const STROM_SERVICE_ID = 'eyevinn-strom'
const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry
// Abort a token exchange that hangs. Without this a token service that
// accepts the connection but never answers would leave the shared
// inflightExchange pending forever, blocking every Strom caller.
const EXCHANGE_TIMEOUT_MS = 10 * 1000

interface SatCache {
  token: string
  expiresAt: number // unix ms
}

// Per-(serviceId, PAT) SAT cache and in-flight exchange. A SAT is scoped to one
// OSC serviceId, so Strom (`eyevinn-strom`) and intercom-manager
// (`eyevinn-intercom-manager`, issue #598) each keep their own entry.
const caches = new Map<string, SatCache>()
// Coalesce concurrent token exchange requests to avoid burst PAT exhaustion
const inflightExchanges = new Map<string, Promise<string>>()

function isExpiringSoon(cache: SatCache): boolean {
  return Date.now() >= cache.expiresAt - REFRESH_BUFFER_MS
}

/**
 * Returns a valid Strom auth token.
 *
 * - STROM_AUTH_MODE=direct: returns the API key as-is (self-hosted Strom)
 * - STROM_AUTH_MODE=osc (default): exchanges the PAT for a short-lived SAT
 *   via the OSC token service (required for OSC-hosted Strom instances)
 *
 * Returns undefined if no token is configured (local dev without auth).
 */
export async function getStromToken(pat: string | undefined): Promise<string | undefined> {
  if (!pat) return undefined

  // Direct mode: API key is used as Bearer token without any exchange
  if (process.env['STROM_AUTH_MODE'] === 'direct') {
    return pat
  }

  return getOscServiceToken(pat, STROM_SERVICE_ID)
}

/**
 * Exchanges an OSC Personal Access Token for a short-lived Service Access Token
 * scoped to `serviceId`, cached per service and refreshed 5 min before expiry.
 * Concurrent callers for the same service share one in-flight exchange, and a
 * failed refresh keeps serving a cached SAT that has not actually expired yet.
 *
 * Generalised from the Strom-only exchange so the intercom-manager client can
 * use it with `eyevinn-intercom-manager` (issue #598, guest-talkback spec OQ3).
 */
export async function getOscServiceToken(pat: string, serviceId: string): Promise<string> {
  // Key on the PAT too, so a rotated PAT never reuses a SAT minted for the old one.
  const key = `${serviceId}\u0000${pat}`
  const cached = caches.get(key)
  if (cached && !isExpiringSoon(cached)) {
    return cached.token
  }

  // Coalesce: if an exchange is already in-flight, wait for it instead of
  // issuing a duplicate request. This prevents burst activations from
  // exhausting OSC per-PAT rate limits after a SAT expiry.
  const inflight = inflightExchanges.get(key)
  if (inflight) {
    return inflight
  }

  // Snapshot the current cache so a failed refresh can fall back to a SAT
  // that is still valid (expiring soon, but not actually expired yet).
  const previous = cached

  const exchange = fetch(TOKEN_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'x-pat-jwt': `Bearer ${pat}`,
    },
    body: JSON.stringify({ serviceId }),
    // Bound the exchange so a hung token service rejects (and clears the
    // in-flight entry below) instead of blocking every caller forever.
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text()
        throw new Error(`SAT exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
      }
      const data = (await res.json()) as { token: string; expiry: number }
      const entry = { token: data.token, expiresAt: data.expiry * 1000 }
      caches.set(key, entry)
      return entry.token
    })
    .catch((err) => {
      // If the refresh failed/timed out but we still hold a SAT that has not
      // actually expired yet, keep serving it rather than failing the caller.
      if (previous && Date.now() < previous.expiresAt) {
        return previous.token
      }
      throw err
    })
    .finally(() => {
      inflightExchanges.delete(key)
    })

  inflightExchanges.set(key, exchange)
  return exchange
}
