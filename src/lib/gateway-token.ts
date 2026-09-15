/**
 * Per-gateway bearer token helpers for the OL-5 Studio Gateways heartbeat
 * socket (issue #263, `docs/decisions/ADR-001-per-gateway-auth-token.md`).
 *
 * A gateway authenticates the heartbeat WebSocket *as itself* with a per-gateway
 * token, NOT the shared `API_KEY`. The raw token is returned to the caller
 * exactly once on create/rotate; only its SHA-256 hash is persisted in
 * `GatewayDoc.tokenHash`, so a database read can never recover a live token.
 *
 * The token is high-entropy random (not a low-entropy password), so a plain
 * SHA-256 is sufficient — a slow KDF buys nothing here (ADR-001). The
 * `olgw_v1_` prefix lets tooling scan for the credential and lets us version
 * the format later.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/** Format version prefix. See ADR-001 for why the prefix is versioned. */
export const GATEWAY_TOKEN_PREFIX = 'olgw_v1_';

/** Bytes of entropy in the opaque secret portion (256 bits). */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Mint a fresh per-gateway token. Returns both the raw token (shown to the
 * caller once) and its SHA-256 hash (the only form persisted).
 */
export function generateGatewayToken(): { token: string; tokenHash: string } {
  // URL-safe base64 (base64url) so the token can travel unescaped in an
  // Authorization header or the Sec-WebSocket-Protocol subprotocol marker.
  const secret = randomBytes(TOKEN_ENTROPY_BYTES).toString('base64url');
  const token = `${GATEWAY_TOKEN_PREFIX}${secret}`;
  return { token, tokenHash: hashGatewayToken(token) };
}

/** SHA-256 hex digest of a raw token, matching what is stored in `tokenHash`. */
export function hashGatewayToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of a presented token against a stored hash. Hashing
 * first normalises the comparison to a fixed-length digest, avoiding a length
 * side-channel and letting `timingSafeEqual` run on equal-length buffers.
 */
export function verifyGatewayToken(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashGatewayToken(token), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
