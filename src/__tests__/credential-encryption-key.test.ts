/**
 * Tests for the backend-generated credential encryption key (issue #438).
 *
 * Mirrors the guest-invite signing-key tests (#391). Covers:
 *   1. first-start generation (no stored key → generate + store under the fixed id),
 *   2. reuse after restart (stored key is read back, never regenerated),
 *   3. the concurrent-create conflict path (insert 409 → re-read the winner's key),
 *   4. the `SRT_PASSPHRASE_KEY` env override (wins, no DB touch),
 *   5. the stored key is wired into the SRT passphrase crypto and the HTML-auth
 *      crypto as a fallback, so an SRT passphrase / HTML credential round-trips
 *      with NO key env var set (the OSC case), and survives a "restart".
 *
 * CouchDB is mocked — no live services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CredentialEncryptionKeyDoc } from '../db/types.js';

// Hoisted so the vi.mock factory can close over it.
const { keysDb } = vi.hoisted(() => ({
  keysDb: {
    get: vi.fn<(id: string) => Promise<CredentialEncryptionKeyDoc>>(),
    insert: vi.fn<(doc: CredentialEncryptionKeyDoc) => Promise<{ ok: true }>>(),
  },
}));

vi.mock('../db/index.js', () => ({ getCredentialEncryptionKeysDb: () => keysDb }));

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}
function conflict(): Error {
  return Object.assign(new Error('conflict'), { statusCode: 409 });
}

import {
  ensureCredentialEncryptionKey,
  getStoredCredentialKey,
  CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
  __resetCredentialEncryptionKeyCacheForTests,
} from '../lib/credential-encryption-key.js';
import {
  encryptPassphrase,
  decryptPassphrase,
  resetKeyCache,
  isEncrypted,
} from '../lib/srt-passphrase-crypto.js';
import {
  encryptHtmlAuthValue,
  decryptHtmlAuthValue,
  resetHtmlAuthKeyCache,
} from '../lib/html-auth-crypto.js';

const originalSrtKey = process.env['SRT_PASSPHRASE_KEY'];
const originalHtmlKey = process.env['HTML_AUTH_KEY'];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['SRT_PASSPHRASE_KEY'];
  delete process.env['HTML_AUTH_KEY'];
  __resetCredentialEncryptionKeyCacheForTests();
  resetKeyCache();
  resetHtmlAuthKeyCache();
});

afterEach(() => {
  if (originalSrtKey === undefined) delete process.env['SRT_PASSPHRASE_KEY'];
  else process.env['SRT_PASSPHRASE_KEY'] = originalSrtKey;
  if (originalHtmlKey === undefined) delete process.env['HTML_AUTH_KEY'];
  else process.env['HTML_AUTH_KEY'] = originalHtmlKey;
});

describe('ensureCredentialEncryptionKey', () => {
  it('generates and stores a key on first start (none present)', async () => {
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });

    const key = await ensureCredentialEncryptionKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key!.length).toBe(32);
    // Stored under the single fixed id, with the right discriminator.
    expect(keysDb.insert).toHaveBeenCalledTimes(1);
    const stored = keysDb.insert.mock.calls[0]![0];
    expect(stored._id).toBe(CREDENTIAL_ENCRYPTION_KEY_DOC_ID);
    expect(stored.type).toBe('credential-encryption-key');
    expect(stored.encryptionSecret).toBeTruthy();
    // The stored value is base64 of exactly 32 bytes.
    expect(Buffer.from(stored.encryptionSecret, 'base64').length).toBe(32);
    expect(stored.createdAt).toBeTruthy();
    // Now cached for the synchronous accessor.
    expect(getStoredCredentialKey()).toEqual(key);
  });

  it('reuses the stored key on restart (reads it, never regenerates)', async () => {
    const existingSecret = Buffer.alloc(32, 7).toString('base64');
    const existing: CredentialEncryptionKeyDoc = {
      _id: CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
      _rev: '3-abc',
      type: 'credential-encryption-key',
      encryptionSecret: existingSecret,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    keysDb.get.mockResolvedValueOnce(existing);

    const key = await ensureCredentialEncryptionKey();

    expect(key).toEqual(Buffer.from(existingSecret, 'base64'));
    expect(keysDb.insert).not.toHaveBeenCalled();
    expect(getStoredCredentialKey()).toEqual(Buffer.from(existingSecret, 'base64'));
  });

  it('on a concurrent-create conflict, re-reads and uses the winner\'s key', async () => {
    const winnerSecret = Buffer.alloc(32, 9).toString('base64');
    keysDb.get
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({
        _id: CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
        _rev: '1-winner',
        type: 'credential-encryption-key',
        encryptionSecret: winnerSecret,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    keysDb.insert.mockRejectedValueOnce(conflict());

    const key = await ensureCredentialEncryptionKey();

    expect(key).toEqual(Buffer.from(winnerSecret, 'base64'));
    expect(keysDb.insert).toHaveBeenCalledTimes(1);
    expect(keysDb.get).toHaveBeenCalledTimes(2);
  });

  it('env SRT_PASSPHRASE_KEY override: no stored key is generated, DB untouched', async () => {
    process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 1).toString('base64');

    const key = await ensureCredentialEncryptionKey();

    expect(key).toBeNull();
    expect(keysDb.get).not.toHaveBeenCalled();
    expect(keysDb.insert).not.toHaveBeenCalled();
    expect(getStoredCredentialKey()).toBeNull();
  });

  it('generates distinct keys across fresh instances (not a constant)', async () => {
    keysDb.get.mockRejectedValue(notFound());
    keysDb.insert.mockResolvedValue({ ok: true });

    const first = await ensureCredentialEncryptionKey();
    __resetCredentialEncryptionKeyCacheForTests();
    const second = await ensureCredentialEncryptionKey();

    expect(first).not.toEqual(second);
  });
});

describe('stored credential key is used by the crypto modules (OSC: no key env var)', () => {
  it('SRT passphrase round-trips via the stored key when no env var is set', async () => {
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureCredentialEncryptionKey();

    const ct = encryptPassphrase('super-secret-srt');
    expect(isEncrypted(ct)).toBe(true); // actually encrypted, not plaintext passthrough
    expect(ct).not.toContain('super-secret-srt');
    expect(decryptPassphrase(ct)).toBe('super-secret-srt');
  });

  it('HTML-source credential round-trips via the stored key when no env var is set', async () => {
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureCredentialEncryptionKey();

    const sourceId = 'src-abc';
    const ct = encryptHtmlAuthValue('Bearer provider-token', sourceId);
    expect(ct.startsWith('encv1:')).toBe(true);
    expect(ct).not.toContain('provider-token');
    expect(decryptHtmlAuthValue(ct, sourceId)).toBe('Bearer provider-token');
  });

  it('a value encrypted under the stored key still decrypts after a restart (key reused)', async () => {
    // First "boot": generate + store.
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureCredentialEncryptionKey();
    const storedSecret = keysDb.insert.mock.calls[0]![0].encryptionSecret;
    const ct = encryptPassphrase('persisted-passphrase');

    // Simulate a restart: fresh in-memory caches, DB returns the same stored doc.
    __resetCredentialEncryptionKeyCacheForTests();
    resetKeyCache();
    keysDb.get.mockResolvedValueOnce({
      _id: CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
      _rev: '1-x',
      type: 'credential-encryption-key',
      encryptionSecret: storedSecret,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await ensureCredentialEncryptionKey();

    expect(decryptPassphrase(ct)).toBe('persisted-passphrase');
  });

  it('SRT_PASSPHRASE_KEY env override wins over the stored key', async () => {
    // A stored key exists...
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureCredentialEncryptionKey();
    const underStored = encryptPassphrase('x');

    // ...but once the env override is set and caches are reset, the env key is
    // used instead (so the stored-key ciphertext no longer decrypts under it).
    resetKeyCache();
    process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 42).toString('base64');
    expect(() => decryptPassphrase(underStored)).toThrow();
    // And a fresh round-trip works under the env key.
    const ct = encryptPassphrase('under-env-key');
    expect(decryptPassphrase(ct)).toBe('under-env-key');
  });
});
