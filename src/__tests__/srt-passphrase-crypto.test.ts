/**
 * Tests for SRT passphrase encryption-at-rest (issue #160).
 *
 * No CouchDB or Strom needed — this exercises the pure crypto module and the
 * route-facing masking behaviour. A deterministic 32-byte test key is injected
 * via process.env.SRT_PASSPHRASE_KEY; resetKeyCache() clears the module cache
 * between env changes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  encryptPassphrase,
  decryptPassphrase,
  isEncrypted,
  encryptAddressPassphrase,
  decryptAddressPassphrase,
  decodeKey,
  loadKey,
  resetKeyCache,
} from '../lib/srt-passphrase-crypto.js';

// 32 bytes of 0x01..0x20 — base64 form used as the default test key.
const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const KEY_B64 = KEY_BYTES.toString('base64');
const KEY_HEX = KEY_BYTES.toString('hex');

const SECRET = 'topsecretvalue';
const SRT_ADDR = `srt://cam.example.com:9000?passphrase=${SECRET}&latency=200`;

const originalEnv = { ...process.env };

beforeEach(() => {
  resetKeyCache();
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetKeyCache();
  vi.restoreAllMocks();
});

describe('key loading', () => {
  it('decodes a base64 key to 32 bytes', () => {
    expect(decodeKey(KEY_B64)).toHaveLength(32);
  });

  it('decodes a hex key to 32 bytes', () => {
    expect(decodeKey(KEY_HEX)).toHaveLength(32);
  });

  it('base64 and hex forms decode to the same key', () => {
    expect(decodeKey(KEY_B64).equals(decodeKey(KEY_HEX))).toBe(true);
  });

  it('throws on a short key', () => {
    expect(() => decodeKey(Buffer.from('too-short').toString('base64'))).toThrow(/32 bytes/);
  });

  it('throws on an empty key', () => {
    expect(() => decodeKey('   ')).toThrow(/empty/);
  });

  it('fails closed in production when the key is unset', () => {
    resetKeyCache();
    delete process.env['SRT_PASSPHRASE_KEY'];
    process.env['NODE_ENV'] = 'production';
    expect(() => loadKey()).toThrow(/required in production/);
  });

  it('returns null (dev fallback) when the key is unset outside production', () => {
    resetKeyCache();
    delete process.env['SRT_PASSPHRASE_KEY'];
    // warn is expected — silence it
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadKey()).toBeNull();
  });
});

describe('encrypt / decrypt round-trip', () => {
  it('produces an encv1 ciphertext that is not the plaintext', () => {
    const ct = encryptPassphrase(SECRET);
    expect(isEncrypted(ct)).toBe(true);
    expect(ct).not.toContain(SECRET);
  });

  it('round-trips a passphrase back to the original', () => {
    expect(decryptPassphrase(encryptPassphrase(SECRET))).toBe(SECRET);
  });

  it('uses a fresh IV each time (ciphertexts differ)', () => {
    expect(encryptPassphrase(SECRET)).not.toBe(encryptPassphrase(SECRET));
  });

  it('does not double-wrap an already-encrypted value', () => {
    const once = encryptPassphrase(SECRET);
    expect(encryptPassphrase(once)).toBe(once);
  });
});

describe('tamper detection (GCM auth tag)', () => {
  it('throws when the ciphertext bundle is altered', () => {
    const ct = encryptPassphrase(SECRET);
    const bundle = Buffer.from(ct.slice('encv1:'.length), 'base64url');
    // Flip a bit in the last (ciphertext) byte.
    bundle[bundle.length - 1] ^= 0x01;
    const tampered = 'encv1:' + bundle.toString('base64url');
    expect(() => decryptPassphrase(tampered)).toThrow();
  });

  it('throws on a truncated/malformed bundle', () => {
    expect(() => decryptPassphrase('encv1:AAAA')).toThrow(/too short|Malformed/i);
  });
});

describe('legacy plaintext pass-through on read', () => {
  it('returns un-prefixed values unchanged', () => {
    expect(decryptPassphrase(SECRET)).toBe(SECRET);
  });

  it('passes a legacy plaintext SRT address through unchanged', () => {
    expect(decryptAddressPassphrase(SRT_ADDR)).toBe(SRT_ADDR);
  });
});

describe('address-level helpers', () => {
  it('encrypts only the passphrase param, leaving host/port/other params intact', () => {
    const stored = encryptAddressPassphrase(SRT_ADDR);
    expect(stored).toContain('srt://cam.example.com:9000');
    expect(stored).toContain('&latency=200');
    expect(stored).toContain('passphrase=encv1:');
    expect(stored).not.toContain(SECRET);
  });

  it('round-trips an SRT address back to the original plaintext', () => {
    const stored = encryptAddressPassphrase(SRT_ADDR);
    expect(decryptAddressPassphrase(stored)).toBe(SRT_ADDR);
  });

  it('leaves addresses without a passphrase unchanged', () => {
    const noPass = 'srt://cam.example.com:9000?latency=200';
    expect(encryptAddressPassphrase(noPass)).toBe(noPass);
    expect(decryptAddressPassphrase(noPass)).toBe(noPass);
  });

  it('leaves an empty passphrase value untouched', () => {
    const empty = 'srt://cam.example.com:9000?passphrase=&latency=200';
    expect(encryptAddressPassphrase(empty)).toBe(empty);
  });

  it('dev fallback (no key) stores plaintext so decrypt still returns the original', () => {
    resetKeyCache();
    delete process.env['SRT_PASSPHRASE_KEY'];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stored = encryptAddressPassphrase(SRT_ADDR);
    expect(stored).toBe(SRT_ADDR); // no encryption applied
    expect(decryptAddressPassphrase(stored)).toBe(SRT_ADDR);
  });
});

describe('API masking still hides the passphrase', () => {
  // Mirror of maskSrtPassphrase() from routes/sources.ts applied after decrypt.
  function maskSrtPassphrase(address: string): string {
    return address.replace(/([?&]passphrase=)[^&]*/gi, '$1***');
  }

  it('masks the decrypted passphrase in an API response', () => {
    const stored = encryptAddressPassphrase(SRT_ADDR);
    const apiAddress = maskSrtPassphrase(decryptAddressPassphrase(stored));
    expect(apiAddress).toBe('srt://cam.example.com:9000?passphrase=***&latency=200');
    expect(apiAddress).not.toContain(SECRET);
  });
});
