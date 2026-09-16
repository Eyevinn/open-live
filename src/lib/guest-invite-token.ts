/**
 * HMAC-signed, expiring guest-invite token helpers (epic #208, issue #299,
 * `docs/specs/guest-calling-intercom.md` §"Guest auth model", §Risks).
 *
 * A guest invite grants WHIP publish into a live production, so tokens are
 * short-lived and stored only as a SHA-256 hash (`GuestInviteDoc.tokenHash`) —
 * the raw token is returned to the operator exactly once on create and never
 * persisted, so a database read can never recover a live token.
 *
 * Token format (opaque to clients):
 *   olgi_v1_<base64url(payload)>.<base64url(hmac-sha256(payload))>
 * where `payload` is a JSON `{ inviteId, productionId, exp }` (exp = epoch
 * seconds). The HMAC is keyed by `GUEST_INVITE_SECRET`. Verification is
 * constant-time and re-checks expiry, so a leaked-but-expired token is useless
 * even before its `GuestInviteDoc` is deleted.
 *
 * The `olgi_v1_` prefix lets tooling scan for the credential and lets us version
 * the format later (mirrors the per-gateway token in `gateway-token.ts`).
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Format version prefix. */
export const GUEST_INVITE_TOKEN_PREFIX = 'olgi_v1_';

/** Claims embedded in (and signed over) a guest invite token. */
export interface GuestInviteTokenClaims {
  inviteId: string;
  productionId: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function signPayload(payloadB64: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

/**
 * Mint a signed invite token. Returns both the raw token (shown to the operator
 * once) and its SHA-256 hash (the only form persisted).
 */
export function generateGuestInviteToken(
  claims: GuestInviteTokenClaims,
  secret: string,
): { token: string; tokenHash: string } {
  const payloadB64 = b64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = signPayload(payloadB64, secret);
  const token = `${GUEST_INVITE_TOKEN_PREFIX}${payloadB64}.${sig}`;
  return { token, tokenHash: hashGuestInviteToken(token) };
}

/** SHA-256 hex digest of a raw token, matching what is stored in `tokenHash`. */
export function hashGuestInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function constantTimeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type GuestInviteTokenError = 'malformed' | 'bad-signature' | 'expired';

export type GuestInviteVerifyResult =
  | { ok: true; claims: GuestInviteTokenClaims }
  | { ok: false; reason: GuestInviteTokenError };

/**
 * Verify a token's signature and expiry against the HMAC secret. Does NOT touch
 * the database — the caller still looks up the `GuestInviteDoc` by `inviteId`
 * and compares `tokenHash` (defence in depth: revocation via DELETE removes the
 * doc even while the signature is still cryptographically valid).
 *
 * `now` is injectable for tests. Uses constant-time signature comparison to
 * avoid a forgery timing side-channel.
 */
export function verifyGuestInviteToken(
  token: string,
  secret: string,
  now: Date = new Date(),
): GuestInviteVerifyResult {
  if (!token.startsWith(GUEST_INVITE_TOKEN_PREFIX)) {
    return { ok: false, reason: 'malformed' };
  }
  const body = token.slice(GUEST_INVITE_TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 0) return { ok: false, reason: 'malformed' };
  const payloadB64 = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  if (!payloadB64 || !sig) return { ok: false, reason: 'malformed' };

  const expectedSig = signPayload(payloadB64, secret);
  if (!constantTimeEqualStr(sig, expectedSig)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let claims: GuestInviteTokenClaims;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.inviteId !== 'string' ||
      typeof parsed.productionId !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'malformed' };
    }
    claims = { inviteId: parsed.inviteId, productionId: parsed.productionId, exp: parsed.exp };
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.exp * 1000 <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}
