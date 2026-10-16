/**
 * Encryption-at-rest round-trip for storage-connection secret keys (issue #520,
 * OL-21, ADR-009 Decision 1).
 *
 * The secret joins the SHARED credential-key family via a dedicated
 * `STORAGE_CONNECTION_KEY` env override. Covers: the `encv1:` round-trip under an
 * env override, that ciphertext is never the plaintext, and that a tampered
 * bundle fails closed.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { encryptStorageSecret, decryptStorageSecret } from '../lib/storage-connection-crypto.js';
import { resetKeyCache, isEncrypted } from '../lib/srt-passphrase-crypto.js';

const KEY = Buffer.alloc(32, 7).toString('base64'); // 32-byte AES-256 key
const original = process.env['STORAGE_CONNECTION_KEY'];

beforeEach(() => {
  process.env['STORAGE_CONNECTION_KEY'] = KEY;
  resetKeyCache();
});

afterAll(() => {
  if (original === undefined) delete process.env['STORAGE_CONNECTION_KEY'];
  else process.env['STORAGE_CONNECTION_KEY'] = original;
  resetKeyCache();
});

describe('storage-connection secret encryption', () => {
  it('round-trips a secret and never stores it in plaintext', () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const enc = encryptStorageSecret(secret);
    expect(isEncrypted(enc)).toBe(true);
    expect(enc.startsWith('encv1:')).toBe(true);
    expect(enc).not.toContain(secret);
    expect(decryptStorageSecret(enc)).toBe(secret);
  });

  it('produces a fresh nonce each time (ciphertext differs, plaintext matches)', () => {
    const a = encryptStorageSecret('same-secret');
    const b = encryptStorageSecret('same-secret');
    expect(a).not.toBe(b);
    expect(decryptStorageSecret(a)).toBe('same-secret');
    expect(decryptStorageSecret(b)).toBe('same-secret');
  });

  it('fails closed on a tampered ciphertext (GCM auth failure)', () => {
    const enc = encryptStorageSecret('secret');
    // Flip a character in the base64url body.
    const tampered = enc.slice(0, -2) + (enc.endsWith('A') ? 'B' : 'A') + enc.slice(-1);
    expect(() => decryptStorageSecret(tampered)).toThrow();
  });

  it('uses STORAGE_CONNECTION_KEY, independent of SRT_PASSPHRASE_KEY', () => {
    // A value encrypted under STORAGE_CONNECTION_KEY must not decrypt under a
    // different key — proving the storage source reads its own env var.
    const enc = encryptStorageSecret('isolated');
    process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 9).toString('base64');
    resetKeyCache();
    expect(() => decryptStorageSecret(enc)).toThrow();
  });
});
