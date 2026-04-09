/**
 * OSC Service Access Token (SAT) manager for Strom.
 *
 * PATs cannot be used directly against OSC-hosted services — they must be
 * exchanged for a short-lived SAT via the OSC token service. This module
 * handles that exchange and caches the SAT, refreshing it 5 minutes before
 * it expires so callers always get a valid token.
 */

const TOKEN_EXCHANGE_URL = 'https://token.svc.prod.osaas.io/servicetoken'
const STROM_SERVICE_ID = 'eyevinn-strom'
const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

interface SatCache {
  token: string
  expiresAt: number // unix ms
}

let cache: SatCache | null = null

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

  if (cache && !isExpiringSoon(cache)) {
    return cache.token
  }

  // (no debug log — exchange is a normal background operation)
  const res = await fetch(TOKEN_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
      'x-pat-jwt': `Bearer ${pat}`,
    },
    body: JSON.stringify({ serviceId: STROM_SERVICE_ID }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`SAT exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`)
  }

  const data = (await res.json()) as { token: string; expiry: number }
  cache = { token: data.token, expiresAt: data.expiry * 1000 }
  return cache.token
}
