/**
 * Tests for RTMP stream-key encryption-at-rest (spec: rtmp-multi-destination.md,
 * ADR-004 Resolved Decision 2 / security condition 3).
 *
 * The RTMP stream key is encrypted under a DEDICATED `RTMP_CREDENTIALS_KEY` —
 * NOT `SRT_PASSPHRASE_KEY` — reusing the generalised srt-passphrase-crypto core.
 * These tests assert the dedicated-key contract, the no-SRT-fallback property,
 * and the fail-closed-in-prod / loud-no-op-in-dev behaviour are preserved.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { encryptStreamKey, decryptStreamKey } from '../lib/rtmp-credentials-crypto.js';
import { resetKeyCache } from '../lib/srt-passphrase-crypto.js';
import { ConfigurationError } from '../lib/config-error.js';

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const RTMP_KEY_B64 = KEY_BYTES.toString('base64');
// A different 32-byte key for SRT, to prove RTMP never reads it.
const SRT_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => 200 - i)).toString('base64');

const STREAM_KEY = 'abcd-1234-efgh-5678';
const originalEnv = { ...process.env };

beforeEach(() => {
  resetKeyCache();
  process.env['RTMP_CREDENTIALS_KEY'] = RTMP_KEY_B64;
  delete process.env['SRT_PASSPHRASE_KEY'];
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetKeyCache();
  vi.restoreAllMocks();
});

describe('RTMP stream-key encrypt/decrypt round-trip', () => {
  it('produces an encv1 ciphertext that is not the plaintext', () => {
    const ct = encryptStreamKey(STREAM_KEY);
    expect(ct.startsWith('encv1:')).toBe(true);
    expect(ct).not.toContain(STREAM_KEY);
  });

  it('round-trips the stream key back to the original', () => {
    expect(decryptStreamKey(encryptStreamKey(STREAM_KEY))).toBe(STREAM_KEY);
  });

  it('uses a fresh IV each time (ciphertexts differ)', () => {
    expect(encryptStreamKey(STREAM_KEY)).not.toBe(encryptStreamKey(STREAM_KEY));
  });
});

describe('dedicated key — no SRT_PASSPHRASE_KEY fallback (ADR-004 Resolved Decision 2)', () => {
  it('does NOT encrypt using SRT_PASSPHRASE_KEY when RTMP_CREDENTIALS_KEY is unset (dev no-op)', () => {
    resetKeyCache();
    delete process.env['RTMP_CREDENTIALS_KEY'];
    process.env['SRT_PASSPHRASE_KEY'] = SRT_KEY_B64; // present, but must be ignored
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // If RTMP fell back to the SRT key it would encrypt; the dedicated-key
    // contract means no RTMP key ⇒ dev no-op (plaintext), never SRT-encrypted.
    expect(encryptStreamKey(STREAM_KEY)).toBe(STREAM_KEY);
  });

  it('encrypts under RTMP_CREDENTIALS_KEY only — SRT key of a different value cannot decrypt it', () => {
    const ct = encryptStreamKey(STREAM_KEY);
    // Swap in the SRT key as if it were the RTMP key: decryption must fail
    // (auth-tag mismatch), proving the ciphertext is bound to the RTMP key.
    resetKeyCache();
    process.env['RTMP_CREDENTIALS_KEY'] = SRT_KEY_B64;
    expect(() => decryptStreamKey(ct)).toThrow();
  });
});

describe('fail-closed in production / loud no-op in dev', () => {
  it('fails closed (typed 503 config error) in production when RTMP_CREDENTIALS_KEY is unset', () => {
    resetKeyCache();
    delete process.env['RTMP_CREDENTIALS_KEY'];
    process.env['NODE_ENV'] = 'production';
    let caught: unknown;
    try {
      encryptStreamKey(STREAM_KEY);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).statusCode).toBe(503);
    expect((caught as ConfigurationError).message).toMatch(/RTMP_CREDENTIALS_KEY/);
  });

  it('never silently returns plaintext for a stored ciphertext when the key is missing (fail closed)', () => {
    const ct = encryptStreamKey(STREAM_KEY);
    resetKeyCache();
    delete process.env['RTMP_CREDENTIALS_KEY'];
    // Even outside production, decrypting an existing ciphertext with no key must
    // throw — never fall through to returning the ciphertext or empty.
    expect(() => decryptStreamKey(ct)).toThrow(/RTMP_CREDENTIALS_KEY/);
  });

  it('dev no-op: with no RTMP key set, encrypt returns plaintext and decrypt returns it unchanged', () => {
    resetKeyCache();
    delete process.env['RTMP_CREDENTIALS_KEY'];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = encryptStreamKey(STREAM_KEY);
    expect(stored).toBe(STREAM_KEY);
    expect(decryptStreamKey(stored)).toBe(STREAM_KEY);
  });
});
