/**
 * Guest-invite HMAC signing key: backend-generated and stored, on by default
 * (issue #391, replaces the `GUEST_INVITE_SECRET` OSC-service-option approach
 * from `docs/specs/guest-calling-provisioning.md` §2.1/§2.2).
 *
 * Resolution order for the key used to sign/verify guest invite tokens:
 *   1. `GUEST_INVITE_SECRET` (env) — an optional override. If set it always
 *      wins, so existing self-hosted setups keep working unchanged.
 *   2. Otherwise a key the backend generates itself on first use and stores in
 *      its own CouchDB under a single fixed id (`GUEST_SIGNING_KEY_DOC_ID`).
 *      Every later start reads that stored key back, so a restart keeps existing
 *      invites valid (the key is reused, not regenerated).
 *
 * Because a key is always available once `ensureGuestSigningKey()` has run,
 * guest calling is ON by default on every instance. Whether a production
 * actually has guests is decided per production — an invite can only target a
 * declared guest slot (#381), so a production with no guest slots gets none.
 *
 * The key is a credential: it is NEVER logged (redacted via the `secret`
 * substring in `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 *
 * Out of scope (issue #391): key rotation, per-production keys, talkback.
 */

import { randomBytes } from 'crypto';
import { config } from '../config.js';
import { getGuestSigningKeysDb } from '../db/index.js';
import type { GuestSigningKeyDoc } from '../db/types.js';

/** Single fixed document id for the stored signing key — at most one per instance. */
export const GUEST_SIGNING_KEY_DOC_ID = 'guest-invite-signing-key';

/**
 * In-memory cache of the stored key, populated by `ensureGuestSigningKey()`.
 * The env override is NOT cached here — it is read live from `config` so
 * `getGuestSigningKey()` reflects it even before `ensureGuestSigningKey()` runs.
 */
let cachedStoredKey: string | undefined;

function hasStatus(err: unknown, status: number): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === status;
}

/** Generate a fresh 32-byte random signing key (base64url). */
function generateKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Ensure a stored signing key exists and is cached, returning the effective key.
 *
 * Called once at startup (after the DB connects). Idempotent and race-safe:
 * - env override set ⇒ return it, never touch the DB;
 * - stored doc present ⇒ read and cache it;
 * - stored doc absent ⇒ generate one and `insert()` under the fixed id. If two
 *   backend processes race on first start, the loser's insert gets a `409`
 *   conflict; it re-reads and uses the winner's key, so all processes end up
 *   signing with the same key.
 */
export async function ensureGuestSigningKey(): Promise<string> {
  // 1. Env override always wins and must never be persisted.
  if (config.guestInviteSecret) return config.guestInviteSecret;
  if (cachedStoredKey) return cachedStoredKey;

  const db = getGuestSigningKeysDb();

  // 2. Reuse the stored key if one already exists (restart / second process).
  try {
    const doc = await db.get(GUEST_SIGNING_KEY_DOC_ID);
    cachedStoredKey = doc.signingSecret;
    return cachedStoredKey;
  } catch (err) {
    if (!hasStatus(err, 404)) throw err;
  }

  // 3. First start: create the key only if absent.
  const doc: GuestSigningKeyDoc = {
    _id: GUEST_SIGNING_KEY_DOC_ID,
    type: 'guest-signing-key',
    signingSecret: generateKey(),
    createdAt: new Date().toISOString(),
  };
  try {
    await db.insert(doc);
    cachedStoredKey = doc.signingSecret;
    return cachedStoredKey;
  } catch (err) {
    if (!hasStatus(err, 409)) throw err;
    // Lost the create race — another process won. Re-read and use the winner's key.
    const winner = await db.get(GUEST_SIGNING_KEY_DOC_ID);
    cachedStoredKey = winner.signingSecret;
    return cachedStoredKey;
  }
}

/**
 * The effective signing key, or `undefined` if none is available yet (no env
 * override and `ensureGuestSigningKey()` has not populated the cache — e.g. the
 * DB was unreachable at startup). Synchronous: safe on the route hot path.
 */
export function getGuestSigningKey(): string | undefined {
  return config.guestInviteSecret ?? cachedStoredKey;
}

/** True once a signing key is available (env override or stored). */
export function isGuestSigningKeyAvailable(): boolean {
  return Boolean(getGuestSigningKey());
}

/** Test-only: clear the in-memory cache so each case starts from a fresh state. */
export function __resetGuestSigningKeyCacheForTests(): void {
  cachedStoredKey = undefined;
}
