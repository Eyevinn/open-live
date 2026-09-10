/**
 * OSC service-token (SAT) exchange helper.
 *
 * Exchanges a long-lived OSC Personal Access Token (PAT) for a short-lived
 * Service Access Token (SAT) via the OSC token service. Mirrors the exchange
 * performed in src/lib/strom-token.ts, but is generic over the target
 * serviceId so it can be reused by the auth endpoint (issue #204).
 *
 * SECURITY: the exchange endpoint is a fixed constant (not caller-supplied) so
 * this cannot be turned into an SSRF against arbitrary token endpoints. The
 * PAT is only ever sent to this fixed URL and is never returned to callers.
 */

/** Fixed OSC token-exchange endpoint. Never caller-controlled (anti-SSRF). */
export const TOKEN_EXCHANGE_URL = 'https://token.svc.prod.osaas.io/servicetoken'

export interface ServiceToken {
  /** The short-lived Service Access Token (SAT). */
  token: string
  /** Expiry as a unix timestamp in seconds (as returned by the token service). */
  expiry: number
}

/** Raised when the upstream token service is unreachable or returns an error. */
export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenExchangeError'
  }
}

/**
 * Exchange a PAT for a short-lived SAT scoped to `serviceId`.
 *
 * @throws {TokenExchangeError} if the upstream token service is unreachable or
 *   responds with a non-2xx status. Callers should surface this as a 502.
 */
export async function exchangeServiceToken(pat: string, serviceId: string): Promise<ServiceToken> {
  let res: Response
  try {
    res = await fetch(TOKEN_EXCHANGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'x-pat-jwt': `Bearer ${pat}`,
      },
      body: JSON.stringify({ serviceId }),
    })
  } catch (err) {
    // Network-level failure (DNS, connection refused, timeout, …).
    throw new TokenExchangeError(
      `token service unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TokenExchangeError(
      `SAT exchange failed: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    )
  }

  const data = (await res.json()) as { token?: unknown; expiry?: unknown }
  if (typeof data.token !== 'string' || typeof data.expiry !== 'number') {
    throw new TokenExchangeError('token service returned a malformed response')
  }

  return { token: data.token, expiry: data.expiry }
}
