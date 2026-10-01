/**
 * Tests for the backend-generated guest-invite signing key (issue #391).
 *
 * Covers the four required cases:
 *   1. first-start generation (no stored key → generate + store under the fixed id),
 *   2. reuse after restart (stored key is read back, never regenerated),
 *   3. the concurrent-create conflict path (insert 409 → re-read the winner's key),
 *   4. the `GUEST_INVITE_SECRET` env override (wins over the stored key, no DB touch).
 *
 * CouchDB and config are mocked — no live services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GuestSigningKeyDoc } from '../db/types.js';

// Hoisted so the vi.mock factories (which are themselves hoisted) can close over
// them. `config` is mutable so each case can toggle the env override.
const { config, keysDb } = vi.hoisted(() => ({
  config: { guestInviteSecret: undefined as string | undefined },
  keysDb: {
    get: vi.fn<(id: string) => Promise<GuestSigningKeyDoc>>(),
    insert: vi.fn<(doc: GuestSigningKeyDoc) => Promise<{ ok: true }>>(),
  },
}));

vi.mock('../config.js', () => ({ config }));
vi.mock('../db/index.js', () => ({ getGuestSigningKeysDb: () => keysDb }));

// Fake single-document key store errors, matching nano's `statusCode` shape.
function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}
function conflict(): Error {
  return Object.assign(new Error('conflict'), { statusCode: 409 });
}

import {
  ensureGuestSigningKey,
  getGuestSigningKey,
  isGuestSigningKeyAvailable,
  GUEST_SIGNING_KEY_DOC_ID,
  __resetGuestSigningKeyCacheForTests,
} from '../lib/guest-signing-key.js';

beforeEach(() => {
  vi.clearAllMocks();
  config.guestInviteSecret = undefined;
  __resetGuestSigningKeyCacheForTests();
});

describe('ensureGuestSigningKey', () => {
  it('generates and stores a key on first start (none present)', async () => {
    keysDb.get.mockRejectedValueOnce(notFound());
    keysDb.insert.mockResolvedValueOnce({ ok: true });

    const key = await ensureGuestSigningKey();

    expect(key).toBeTruthy();
    expect(typeof key).toBe('string');
    // Stored under the single fixed id, with the right discriminator.
    expect(keysDb.insert).toHaveBeenCalledTimes(1);
    const stored = keysDb.insert.mock.calls[0]![0];
    expect(stored._id).toBe(GUEST_SIGNING_KEY_DOC_ID);
    expect(stored.type).toBe('guest-signing-key');
    expect(stored.signingSecret).toBe(key);
    expect(stored.createdAt).toBeTruthy();
    // Now available and cached.
    expect(isGuestSigningKeyAvailable()).toBe(true);
    expect(getGuestSigningKey()).toBe(key);
  });

  it('reuses the stored key on restart (reads it, never regenerates)', async () => {
    const existing: GuestSigningKeyDoc = {
      _id: GUEST_SIGNING_KEY_DOC_ID,
      _rev: '3-abc',
      type: 'guest-signing-key',
      signingSecret: 'stored-key-from-first-start',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    keysDb.get.mockResolvedValueOnce(existing);

    const key = await ensureGuestSigningKey();

    expect(key).toBe('stored-key-from-first-start');
    // Reuse, not regenerate.
    expect(keysDb.insert).not.toHaveBeenCalled();
    expect(getGuestSigningKey()).toBe('stored-key-from-first-start');
  });

  it('on a concurrent-create conflict, re-reads and uses the winner\'s key', async () => {
    // First read: absent → attempt create. Insert loses the race (409).
    // Re-read returns the winner's stored key.
    keysDb.get
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({
        _id: GUEST_SIGNING_KEY_DOC_ID,
        _rev: '1-winner',
        type: 'guest-signing-key',
        signingSecret: 'winner-process-key',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    keysDb.insert.mockRejectedValueOnce(conflict());

    const key = await ensureGuestSigningKey();

    // The loser ends up signing with the winner's key, not its own generated one.
    expect(key).toBe('winner-process-key');
    expect(keysDb.insert).toHaveBeenCalledTimes(1);
    expect(keysDb.get).toHaveBeenCalledTimes(2);
    expect(getGuestSigningKey()).toBe('winner-process-key');
  });

  it('env GUEST_INVITE_SECRET overrides the stored key and never touches the DB', async () => {
    config.guestInviteSecret = 'env-override-secret';

    const key = await ensureGuestSigningKey();

    expect(key).toBe('env-override-secret');
    expect(keysDb.get).not.toHaveBeenCalled();
    expect(keysDb.insert).not.toHaveBeenCalled();
    expect(getGuestSigningKey()).toBe('env-override-secret');
    expect(isGuestSigningKeyAvailable()).toBe(true);
  });

  it('getGuestSigningKey reflects the env override even before ensure runs', () => {
    expect(getGuestSigningKey()).toBeUndefined();
    expect(isGuestSigningKeyAvailable()).toBe(false);
    config.guestInviteSecret = 'env-override-secret';
    expect(getGuestSigningKey()).toBe('env-override-secret');
    expect(isGuestSigningKeyAvailable()).toBe(true);
  });

  it('generates distinct keys across fresh instances (not a constant)', async () => {
    keysDb.get.mockRejectedValue(notFound());
    keysDb.insert.mockResolvedValue({ ok: true });

    const first = await ensureGuestSigningKey();
    __resetGuestSigningKeyCacheForTests();
    const second = await ensureGuestSigningKey();

    expect(first).not.toBe(second);
  });
});
