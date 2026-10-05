/**
 * Backend-generated credential encryption key (issue #438).
 *
 * On OSC instances no `SRT_PASSPHRASE_KEY` / `HTML_AUTH_KEY` is provisioned, so
 * saving an SRT source passphrase or an authenticated-HTML-source credential
 * failed closed with a 503 ("Credential storage is not configured on this
 * deployment"). This module mirrors the guest-invite signing key (#391,
 * `src/lib/guest-signing-key.ts`): the backend generates a 32-byte AES-256 key
 * itself on first start and stores it in its own CouchDB under a single fixed id
 * (`CREDENTIAL_ENCRYPTION_KEY_DOC_ID`). Every later start reads that stored key
 * back, so a restart keeps existing credentials decryptable (the key is reused,
 * never regenerated).
 *
 * Resolution (per credential kind, in the consuming crypto module):
 *   1. the kind's env var (`SRT_PASSPHRASE_KEY`, `HTML_AUTH_KEY`) — an optional
 *      override. If set it always wins, so self-hosted setups are unchanged.
 *   2. otherwise this stored, backend-generated key.
 *
 * Scope: the SRT passphrase crypto (`srt-passphrase-crypto.ts`) and the HTML-auth
 * crypto (`html-auth-crypto.ts`) fall back here. RTMP stream keys keep their
 * DEDICATED `RTMP_CREDENTIALS_KEY` and NEVER fall back to the stored key
 * (ADR-004 Resolved Decision 2) — rotating RTMP must stay isolated.
 *
 * The key is a credential: it is NEVER logged (redacted via the `secret`
 * substring in `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 *
 * `credential-encryption-key.ts` imports `db/index.ts`, which imports
 * `config.ts` — an existing cycle (see `guest-signing-key.ts`). It is safe only
 * because no binding is used at module-eval time; keep it that way (do not call
 * these at top level).
 */

import { randomBytes } from 'crypto';
import { getCredentialEncryptionKeysDb } from '../db/index.js';
import type { CredentialEncryptionKeyDoc } from '../db/types.js';

/** 32-byte AES-256 key. */
const KEY_BYTES = 32;

/** Single fixed document id for the stored credential key — at most one per instance. */
export const CREDENTIAL_ENCRYPTION_KEY_DOC_ID = 'credential-encryption-key';

/**
 * In-memory cache of the decoded stored key, populated by
 * `ensureCredentialEncryptionKey()`. `undefined` = not yet resolved; `null` =
 * resolved but intentionally absent (the `SRT_PASSPHRASE_KEY` env override is
 * set, so no stored key is needed — see below).
 */
let cachedKey: Buffer | null | undefined;

function hasStatus(err: unknown, status: number): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === status;
}

/** Generate a fresh 32-byte random key, base64-encoded for storage. */
function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/**
 * Ensure a stored credential key exists and is cached, returning the effective
 * decoded key (or `null` when a stored key is deliberately not used).
 *
 * Called once at startup (after the DB connects). Idempotent and race-safe:
 * - `SRT_PASSPHRASE_KEY` env override set ⇒ no stored key is needed. It is the
 *   shared base key both the SRT and HTML crypto already resolve to (HTML_AUTH_KEY
 *   falls back to SRT_PASSPHRASE_KEY), so the DB is never touched and existing
 *   self-hosted deployments are unchanged. Returns `null`.
 * - stored doc present ⇒ read, decode and cache it;
 * - stored doc absent ⇒ generate one and `insert()` under the fixed id. If two
 *   backend processes race on first start, the loser's insert gets a `409`
 *   conflict; it re-reads and uses the winner's key, so all processes end up
 *   encrypting with the same key.
 */
export async function ensureCredentialEncryptionKey(): Promise<Buffer | null> {
  // 1. The shared SRT_PASSPHRASE_KEY env override makes a stored key unnecessary
  //    (both SRT and HTML resolve to it). Never persist anything in that case.
  if (process.env['SRT_PASSPHRASE_KEY']) {
    cachedKey = null;
    return null;
  }
  if (cachedKey !== undefined) return cachedKey;

  const db = getCredentialEncryptionKeysDb();

  // 2. Reuse the stored key if one already exists (restart / second process).
  try {
    const doc = await db.get(CREDENTIAL_ENCRYPTION_KEY_DOC_ID);
    cachedKey = decodeStoredKey(doc.encryptionSecret);
    return cachedKey;
  } catch (err) {
    if (!hasStatus(err, 404)) throw err;
  }

  // 3. First start: create the key only if absent.
  const doc: CredentialEncryptionKeyDoc = {
    _id: CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
    type: 'credential-encryption-key',
    encryptionSecret: generateKey(),
    createdAt: new Date().toISOString(),
  };
  try {
    await db.insert(doc);
    cachedKey = decodeStoredKey(doc.encryptionSecret);
    return cachedKey;
  } catch (err) {
    if (!hasStatus(err, 409)) throw err;
    // Lost the create race — another process won. Re-read and use the winner's key.
    const winner = await db.get(CREDENTIAL_ENCRYPTION_KEY_DOC_ID);
    cachedKey = decodeStoredKey(winner.encryptionSecret);
    return cachedKey;
  }
}

/**
 * Decode a stored base64 key to a 32-byte Buffer. The key is always generated by
 * `generateKey()` above so this should never fail; a malformed stored value
 * (e.g. hand-edited) throws rather than silently using a wrong-length key.
 */
function decodeStoredKey(raw: string): Buffer {
  const buf = Buffer.from(raw.trim(), 'base64');
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `Stored credential encryption key must decode to ${KEY_BYTES} bytes; got ${buf.length}`,
    );
  }
  return buf;
}

/**
 * The effective stored credential key, or `null` if none is available yet (no
 * stored key, or `ensureCredentialEncryptionKey()` has not populated the cache —
 * e.g. the DB was unreachable at startup). Synchronous: safe on the hot path the
 * crypto modules call it from.
 */
export function getStoredCredentialKey(): Buffer | null {
  return cachedKey ?? null;
}

/** Test-only: clear the in-memory cache so each case starts from a fresh state. */
export function __resetCredentialEncryptionKeyCacheForTests(): void {
  cachedKey = undefined;
}
