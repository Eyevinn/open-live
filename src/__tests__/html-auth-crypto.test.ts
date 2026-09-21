/**
 * Tests for authenticated-HTML-source credential encryption-at-rest (issue #314,
 * `docs/specs/authenticated-html-sources.md`, ADR-003 Decision 2 & 4).
 *
 * Pure crypto module — no CouchDB or Strom needed. A deterministic 32-byte test
 * key is injected via process.env; resetHtmlAuthKeyCache() clears the module
 * cache between env changes. Verifies round-trip, the source-id GCM AAD binding,
 * the HTML_AUTH_KEY → SRT_PASSPHRASE_KEY fallback, fail-closed-in-production, and
 * that the plaintext never appears in the ciphertext (canary).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encryptHtmlAuthValue,
  decryptHtmlAuthValue,
  isEncrypted,
  loadHtmlAuthKey,
  resetHtmlAuthKeyCache,
} from '../lib/html-auth-crypto.js';

// 32 bytes of 0x01..0x20 — base64 form used as the default test key.
const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const KEY_B64 = KEY_BYTES.toString('base64');
// A distinct second key so the fallback path is provably exercised.
const ALT_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 100)).toString('base64');

const SECRET = 'Bearer eyJhbGciOi-CANARY-SECRET-DO-NOT-LEAK';
const SOURCE_ID = 'src-1111';

const originalEnv = { ...process.env };

beforeEach(() => {
  resetHtmlAuthKeyCache();
  process.env['HTML_AUTH_KEY'] = KEY_B64;
  delete process.env['SRT_PASSPHRASE_KEY'];
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetHtmlAuthKeyCache();
  vi.restoreAllMocks();
});

describe('key loading & fallback', () => {
  it('loads HTML_AUTH_KEY when set', () => {
    expect(loadHtmlAuthKey()).toHaveLength(32);
  });

  it('falls back to SRT_PASSPHRASE_KEY when HTML_AUTH_KEY is unset', () => {
    delete process.env['HTML_AUTH_KEY'];
    process.env['SRT_PASSPHRASE_KEY'] = ALT_KEY_B64;
    resetHtmlAuthKeyCache();
    expect(loadHtmlAuthKey()?.equals(Buffer.from(ALT_KEY_B64, 'base64'))).toBe(true);
  });

  it('prefers HTML_AUTH_KEY over SRT_PASSPHRASE_KEY when both are set', () => {
    process.env['HTML_AUTH_KEY'] = KEY_B64;
    process.env['SRT_PASSPHRASE_KEY'] = ALT_KEY_B64;
    resetHtmlAuthKeyCache();
    expect(loadHtmlAuthKey()?.equals(Buffer.from(KEY_B64, 'base64'))).toBe(true);
  });

  it('fails closed in production when neither key is set', () => {
    delete process.env['HTML_AUTH_KEY'];
    delete process.env['SRT_PASSPHRASE_KEY'];
    process.env['NODE_ENV'] = 'production';
    resetHtmlAuthKeyCache();
    expect(() => loadHtmlAuthKey()).toThrow(/required in production/);
  });

  it('returns null (loud no-op) in non-production when no key is set', () => {
    delete process.env['HTML_AUTH_KEY'];
    delete process.env['SRT_PASSPHRASE_KEY'];
    resetHtmlAuthKeyCache();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadHtmlAuthKey()).toBeNull();
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('produces an encv1: bundle and round-trips back to plaintext', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.startsWith('encv1:')).toBe(true);
    expect(decryptHtmlAuthValue(enc, SOURCE_ID)).toBe(SECRET);
  });

  it('never contains the plaintext in the ciphertext (canary)', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    expect(enc).not.toContain('CANARY');
    expect(enc).not.toContain(SECRET);
  });

  it('uses a fresh nonce per encrypt (two ciphertexts differ)', () => {
    const a = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    const b = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    expect(a).not.toBe(b);
    expect(decryptHtmlAuthValue(a, SOURCE_ID)).toBe(SECRET);
    expect(decryptHtmlAuthValue(b, SOURCE_ID)).toBe(SECRET);
  });

  it('does not double-wrap an already-encrypted value', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    expect(encryptHtmlAuthValue(enc, SOURCE_ID)).toBe(enc);
  });
});

describe('source-id GCM AAD binding (ADR-003 Decision 4)', () => {
  it('fails to decrypt a ciphertext under a different source id', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    expect(() => decryptHtmlAuthValue(enc, 'src-other')).toThrow();
  });
});

describe('fail-closed decryption', () => {
  it('throws when a stored ciphertext exists but no key is configured', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    delete process.env['HTML_AUTH_KEY'];
    delete process.env['SRT_PASSPHRASE_KEY'];
    resetHtmlAuthKeyCache();
    expect(() => decryptHtmlAuthValue(enc, SOURCE_ID)).toThrow(/is not set/);
  });

  it('throws under a wrong/rotated key rather than returning garbage', () => {
    const enc = encryptHtmlAuthValue(SECRET, SOURCE_ID);
    process.env['HTML_AUTH_KEY'] = ALT_KEY_B64;
    resetHtmlAuthKeyCache();
    expect(() => decryptHtmlAuthValue(enc, SOURCE_ID)).toThrow();
  });

  it('passes legacy plaintext through unchanged', () => {
    expect(decryptHtmlAuthValue('plain-legacy', SOURCE_ID)).toBe('plain-legacy');
  });
});
