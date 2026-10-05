/**
 * Tests for the backend-generated DEDICATED RTMP stream-key encryption key
 * (issue #447).
 *
 * Mirrors the credential-encryption-key tests (#446), but for the RTMP key —
 * which ADR-004 Resolved Decision 2 keeps DELIBERATELY SEPARATE from the
 * SRT/credential key. Covers:
 *   1. first-start generation (no stored key → generate + store under the fixed id),
 *   2. reuse after restart (stored key is read back, never regenerated),
 *   3. the concurrent-create conflict path (insert 409 → re-read the winner's key),
 *   4. the `RTMP_CREDENTIALS_KEY` env override (wins, no DB touch),
 *   5. the stored RTMP key is wired into the RTMP stream-key crypto as a fallback,
 *      so a stream key round-trips with NO key env var set (the OSC case) and
 *      survives a "restart",
 *   6. key separation: the RTMP stored key is NOT the SRT/credential stored key.
 *
 * CouchDB is mocked — no live services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RtmpCredentialKeyDoc } from '../db/types.js';

// Hoisted so the vi.mock factory can close over it.
const { rtmpKeysDb, credKeysDb } = vi.hoisted(() => ({
  rtmpKeysDb: {
    get: vi.fn<(id: string) => Promise<RtmpCredentialKeyDoc>>(),
    insert: vi.fn<(doc: RtmpCredentialKeyDoc) => Promise<{ ok: true }>>(),
  },
  credKeysDb: {
    get: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  getRtmpCredentialKeysDb: () => rtmpKeysDb,
  getCredentialEncryptionKeysDb: () => credKeysDb,
}));

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}
function conflict(): Error {
  return Object.assign(new Error('conflict'), { statusCode: 409 });
}

import {
  ensureRtmpCredentialKey,
  getStoredRtmpCredentialKey,
  RTMP_CREDENTIAL_KEY_DOC_ID,
  __resetRtmpCredentialKeyCacheForTests,
} from '../lib/rtmp-credential-key.js';
import {
  ensureCredentialEncryptionKey,
  CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
  __resetCredentialEncryptionKeyCacheForTests,
} from '../lib/credential-encryption-key.js';
import { encryptStreamKey, decryptStreamKey } from '../lib/rtmp-credentials-crypto.js';
import { resetKeyCache, isEncrypted } from '../lib/srt-passphrase-crypto.js';

const originalRtmpKey = process.env['RTMP_CREDENTIALS_KEY'];
const originalSrtKey = process.env['SRT_PASSPHRASE_KEY'];
const originalNodeEnv = process.env['NODE_ENV'];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['RTMP_CREDENTIALS_KEY'];
  delete process.env['SRT_PASSPHRASE_KEY'];
  delete process.env['NODE_ENV'];
  __resetRtmpCredentialKeyCacheForTests();
  __resetCredentialEncryptionKeyCacheForTests();
  resetKeyCache();
});

afterEach(() => {
  if (originalRtmpKey === undefined) delete process.env['RTMP_CREDENTIALS_KEY'];
  else process.env['RTMP_CREDENTIALS_KEY'] = originalRtmpKey;
  if (originalSrtKey === undefined) delete process.env['SRT_PASSPHRASE_KEY'];
  else process.env['SRT_PASSPHRASE_KEY'] = originalSrtKey;
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
  vi.restoreAllMocks();
});

describe('ensureRtmpCredentialKey', () => {
  it('generates and stores a key on first start (none present)', async () => {
    rtmpKeysDb.get.mockRejectedValueOnce(notFound());
    rtmpKeysDb.insert.mockResolvedValueOnce({ ok: true });

    const key = await ensureRtmpCredentialKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(key!.length).toBe(32);
    // Stored under the single fixed id, with the right discriminator.
    expect(rtmpKeysDb.insert).toHaveBeenCalledTimes(1);
    const stored = rtmpKeysDb.insert.mock.calls[0]![0];
    expect(stored._id).toBe(RTMP_CREDENTIAL_KEY_DOC_ID);
    expect(stored.type).toBe('rtmp-credentials-key');
    expect(stored.encryptionSecret).toBeTruthy();
    // The stored value is base64 of exactly 32 bytes.
    expect(Buffer.from(stored.encryptionSecret, 'base64').length).toBe(32);
    expect(stored.createdAt).toBeTruthy();
    // Now cached for the synchronous accessor.
    expect(getStoredRtmpCredentialKey()).toEqual(key);
  });

  it('uses its OWN doc id, distinct from the credential-encryption key (#446)', () => {
    expect(RTMP_CREDENTIAL_KEY_DOC_ID).toBe('rtmp-credentials-key');
    expect(RTMP_CREDENTIAL_KEY_DOC_ID).not.toBe(CREDENTIAL_ENCRYPTION_KEY_DOC_ID);
  });

  it('reuses the stored key on restart (reads it, never regenerates)', async () => {
    const existingSecret = Buffer.alloc(32, 7).toString('base64');
    const existing: RtmpCredentialKeyDoc = {
      _id: RTMP_CREDENTIAL_KEY_DOC_ID,
      _rev: '3-abc',
      type: 'rtmp-credentials-key',
      encryptionSecret: existingSecret,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    rtmpKeysDb.get.mockResolvedValueOnce(existing);

    const key = await ensureRtmpCredentialKey();

    expect(key).toEqual(Buffer.from(existingSecret, 'base64'));
    expect(rtmpKeysDb.insert).not.toHaveBeenCalled();
    expect(getStoredRtmpCredentialKey()).toEqual(Buffer.from(existingSecret, 'base64'));
  });

  it('on a concurrent-create conflict, re-reads and uses the winner\'s key', async () => {
    const winnerSecret = Buffer.alloc(32, 9).toString('base64');
    rtmpKeysDb.get
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({
        _id: RTMP_CREDENTIAL_KEY_DOC_ID,
        _rev: '1-winner',
        type: 'rtmp-credentials-key',
        encryptionSecret: winnerSecret,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    rtmpKeysDb.insert.mockRejectedValueOnce(conflict());

    const key = await ensureRtmpCredentialKey();

    expect(key).toEqual(Buffer.from(winnerSecret, 'base64'));
    expect(rtmpKeysDb.insert).toHaveBeenCalledTimes(1);
    expect(rtmpKeysDb.get).toHaveBeenCalledTimes(2);
  });

  it('env RTMP_CREDENTIALS_KEY override: no stored key is generated, DB untouched', async () => {
    process.env['RTMP_CREDENTIALS_KEY'] = Buffer.alloc(32, 1).toString('base64');

    const key = await ensureRtmpCredentialKey();

    expect(key).toBeNull();
    expect(rtmpKeysDb.get).not.toHaveBeenCalled();
    expect(rtmpKeysDb.insert).not.toHaveBeenCalled();
    expect(getStoredRtmpCredentialKey()).toBeNull();
  });

  it('is unaffected by SRT_PASSPHRASE_KEY (separate key families, ADR-004)', async () => {
    // An SRT env key is present, but it must NOT suppress RTMP key generation —
    // the RTMP key only keys off RTMP_CREDENTIALS_KEY.
    process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 5).toString('base64');
    rtmpKeysDb.get.mockRejectedValueOnce(notFound());
    rtmpKeysDb.insert.mockResolvedValueOnce({ ok: true });

    const key = await ensureRtmpCredentialKey();

    expect(key).toBeInstanceOf(Buffer);
    expect(rtmpKeysDb.insert).toHaveBeenCalledTimes(1);
  });

  it('generates distinct keys across fresh instances (not a constant)', async () => {
    rtmpKeysDb.get.mockRejectedValue(notFound());
    rtmpKeysDb.insert.mockResolvedValue({ ok: true });

    const first = await ensureRtmpCredentialKey();
    __resetRtmpCredentialKeyCacheForTests();
    const second = await ensureRtmpCredentialKey();

    expect(first).not.toEqual(second);
  });
});

describe('stored RTMP key is used by the RTMP crypto (OSC: no key env var)', () => {
  it('RTMP stream key round-trips via the stored key when no env var is set', async () => {
    rtmpKeysDb.get.mockRejectedValueOnce(notFound());
    rtmpKeysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureRtmpCredentialKey();

    const ct = encryptStreamKey('yt-live-abcd-1234');
    expect(isEncrypted(ct)).toBe(true); // actually encrypted, not plaintext passthrough
    expect(ct).not.toContain('yt-live-abcd-1234');
    expect(decryptStreamKey(ct)).toBe('yt-live-abcd-1234');
  });

  it('a stream key encrypted under the stored key still decrypts after a restart (key reused)', async () => {
    // First "boot": generate + store.
    rtmpKeysDb.get.mockRejectedValueOnce(notFound());
    rtmpKeysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureRtmpCredentialKey();
    const storedSecret = rtmpKeysDb.insert.mock.calls[0]![0].encryptionSecret;
    const ct = encryptStreamKey('persisted-stream-key');

    // Simulate a restart: fresh in-memory caches, DB returns the same stored doc.
    __resetRtmpCredentialKeyCacheForTests();
    resetKeyCache();
    rtmpKeysDb.get.mockResolvedValueOnce({
      _id: RTMP_CREDENTIAL_KEY_DOC_ID,
      _rev: '1-x',
      type: 'rtmp-credentials-key',
      encryptionSecret: storedSecret,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await ensureRtmpCredentialKey();

    expect(decryptStreamKey(ct)).toBe('persisted-stream-key');
  });

  it('RTMP_CREDENTIALS_KEY env override wins over the stored key', async () => {
    // A stored RTMP key exists...
    rtmpKeysDb.get.mockRejectedValueOnce(notFound());
    rtmpKeysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureRtmpCredentialKey();
    const underStored = encryptStreamKey('x');

    // ...but once the env override is set and caches are reset, the env key is
    // used instead (so the stored-key ciphertext no longer decrypts under it).
    resetKeyCache();
    process.env['RTMP_CREDENTIALS_KEY'] = Buffer.alloc(32, 42).toString('base64');
    expect(() => decryptStreamKey(underStored)).toThrow();
    // And a fresh round-trip works under the env key.
    const ct = encryptStreamKey('under-env-key');
    expect(decryptStreamKey(ct)).toBe('under-env-key');
  });

  it('does NOT use the SRT/credential stored key (ADR-004 key separation)', async () => {
    // Only the shared credential-encryption key (#446) is available — the RTMP
    // key was never ensured. RTMP must NOT fall back to it: with no RTMP key the
    // crypto degrades to a dev no-op (plaintext), never SRT/credential-encrypted.
    credKeysDb.get.mockRejectedValueOnce(notFound());
    credKeysDb.insert.mockResolvedValueOnce({ ok: true });
    await ensureCredentialEncryptionKey(); // populates the SRT/credential stored key only

    expect(getStoredRtmpCredentialKey()).toBeNull();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No RTMP key (env or stored) ⇒ dev no-op, proving no cross-use of the
    // credential key.
    expect(encryptStreamKey('must-not-encrypt')).toBe('must-not-encrypt');
  });
});
