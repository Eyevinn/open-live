/**
 * Unit tests for the per-gateway bearer token helpers (issue #263, ADR-001).
 *
 * The raw token is high-entropy random, prefixed `olgw_v1_`, and only its
 * SHA-256 hash is persisted. Verification is a constant-time hash comparison.
 */

import { describe, it, expect } from 'vitest';
import {
  generateGatewayToken,
  hashGatewayToken,
  verifyGatewayToken,
  GATEWAY_TOKEN_PREFIX,
} from '../lib/gateway-token.js';

describe('gateway-token (ADR-001)', () => {
  it('mints a prefixed token and returns its SHA-256 hash (not the raw token)', () => {
    const { token, tokenHash } = generateGatewayToken();
    expect(token.startsWith(GATEWAY_TOKEN_PREFIX)).toBe(true);
    // hash is a 64-char hex sha256 digest and is not the raw token
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
    expect(hashGatewayToken(token)).toBe(tokenHash);
  });

  it('produces a unique token per call', () => {
    const a = generateGatewayToken();
    const b = generateGatewayToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('verifies a correct token against its stored hash', () => {
    const { token, tokenHash } = generateGatewayToken();
    expect(verifyGatewayToken(token, tokenHash)).toBe(true);
  });

  it('rejects a wrong token, a tampered hash, and malformed input', () => {
    const { token, tokenHash } = generateGatewayToken();
    expect(verifyGatewayToken(`${token}x`, tokenHash)).toBe(false);
    expect(verifyGatewayToken(token, 'deadbeef')).toBe(false);
    expect(verifyGatewayToken(token, 'not-hex-zzzz')).toBe(false);
    expect(verifyGatewayToken('', tokenHash)).toBe(false);
  });
});
