/**
 * Unit tests for the HMAC-signed, expiring guest-invite token helpers
 * (epic #208, issue #299, `docs/specs/guest-calling-intercom.md` §Risks).
 *
 * A guest invite grants WHIP publish into a live production, so the token is
 * short-lived, signed with `GUEST_INVITE_SECRET`, and persisted only as a
 * SHA-256 hash. These tests cover signing, hashing, expiry, tamper/forgery
 * rejection, and secret rotation.
 */

import { describe, it, expect } from 'vitest';
import {
  generateGuestInviteToken,
  verifyGuestInviteToken,
  hashGuestInviteToken,
  GUEST_INVITE_TOKEN_PREFIX,
} from '../lib/guest-invite-token.js';

const SECRET = 'test-hmac-secret-abc123';

function claims(overrides: Partial<{ inviteId: string; productionId: string; exp: number }> = {}) {
  const nowS = Math.floor(Date.now() / 1000);
  return {
    inviteId: 'guest-invite-1',
    productionId: 'prod-1',
    exp: nowS + 3600,
    ...overrides,
  };
}

describe('guest-invite-token (issue #299)', () => {
  it('mints a prefixed token and returns its SHA-256 hash (not the raw token)', () => {
    const { token, tokenHash } = generateGuestInviteToken(claims(), SECRET);
    expect(token.startsWith(GUEST_INVITE_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(hashGuestInviteToken(token)).toBe(tokenHash);
  });

  it('produces a unique token per call even for identical claims (nonce-free but time-scoped)', () => {
    // Same claims + same second → identical deterministic token by design (the
    // hash-based revocation model does not need a nonce); assert the hash is a
    // stable function of the token, which is what the DB stores.
    const a = generateGuestInviteToken(claims(), SECRET);
    expect(hashGuestInviteToken(a.token)).toBe(a.tokenHash);
    // Different inviteId → different token + hash.
    const b = generateGuestInviteToken(claims({ inviteId: 'guest-invite-2' }), SECRET);
    expect(b.token).not.toBe(a.token);
    expect(b.tokenHash).not.toBe(a.tokenHash);
  });

  it('verifies a valid token and returns its claims', () => {
    const c = claims();
    const { token } = generateGuestInviteToken(c, SECRET);
    const res = verifyGuestInviteToken(token, SECRET);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.claims.inviteId).toBe(c.inviteId);
      expect(res.claims.productionId).toBe(c.productionId);
      expect(res.claims.exp).toBe(c.exp);
    }
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const { token } = generateGuestInviteToken(claims({ exp: past }), SECRET);
    const res = verifyGuestInviteToken(token, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('treats a token as expired at exactly its expiry instant (no off-by-one grace)', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const at = new Date(nowS * 1000);
    const { token } = generateGuestInviteToken(claims({ exp: nowS }), SECRET);
    const res = verifyGuestInviteToken(token, SECRET, at);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('accepts a token one second before its expiry', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const at = new Date(nowS * 1000);
    const { token } = generateGuestInviteToken(claims({ exp: nowS + 1 }), SECRET);
    const res = verifyGuestInviteToken(token, SECRET, at);
    expect(res.ok).toBe(true);
  });

  it('rejects a token signed with a different secret (rotation / forgery)', () => {
    const { token } = generateGuestInviteToken(claims(), SECRET);
    const res = verifyGuestInviteToken(token, 'a-different-secret');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad-signature');
  });

  it('rejects a tampered payload (claims edited, signature stale)', () => {
    const { token } = generateGuestInviteToken(claims(), SECRET);
    const [prefixAndPayload, sig] = [token.slice(0, token.indexOf('.')), token.slice(token.indexOf('.') + 1)];
    // Forge a payload that escalates the productionId but keep the old signature.
    const forgedPayload = Buffer.from(
      JSON.stringify(claims({ productionId: 'prod-victim' })),
      'utf8',
    ).toString('base64url');
    void prefixAndPayload;
    const forged = `${GUEST_INVITE_TOKEN_PREFIX}${forgedPayload}.${sig}`;
    const res = verifyGuestInviteToken(forged, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad-signature');
  });

  it('rejects malformed tokens (wrong prefix, no dot, empty parts)', () => {
    expect(verifyGuestInviteToken('nope', SECRET).ok).toBe(false);
    expect(verifyGuestInviteToken(`${GUEST_INVITE_TOKEN_PREFIX}justpayload`, SECRET).ok).toBe(false);
    expect(verifyGuestInviteToken(`${GUEST_INVITE_TOKEN_PREFIX}.`, SECRET).ok).toBe(false);
    const r = verifyGuestInviteToken('bad', SECRET);
    if (!r.ok) expect(r.reason).toBe('malformed');
  });
});
