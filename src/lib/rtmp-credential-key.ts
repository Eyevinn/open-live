/**
 * Backend-generated RTMP stream-key encryption key (issue #447).
 *
 * This is the RTMP analogue of the credential encryption key (#438/#446,
 * `src/lib/credential-encryption-key.ts`), kept DELIBERATELY SEPARATE. ADR-004
 * Resolved Decision 2 requires a dedicated `RTMP_CREDENTIALS_KEY` with NO reuse
 * of / fallback to `SRT_PASSPHRASE_KEY` or the shared credential-encryption key,
 * so RTMP stream-key rotation stays isolated from SRT-passphrase / HTML-auth key
 * rotation.
 *
 * On OSC instances `RTMP_CREDENTIALS_KEY` is never provisioned, so saving an RTMP
 * stream key failed closed with a 503 ("Credential storage is not configured on
 * this deployment") and RTMP publishing was unavailable on every OSC instance.
 * This module mirrors the credential-encryption-key pattern: the backend
 * generates a 32-byte AES-256 key itself on first start and stores it in its own
 * CouchDB under its OWN single fixed id (`RTMP_CREDENTIAL_KEY_DOC_ID`, distinct
 * from `CREDENTIAL_ENCRYPTION_KEY_DOC_ID`). Every later start reads that stored
 * key back, so a restart keeps existing RTMP stream keys decryptable (the key is
 * reused, never regenerated).
 *
 * Resolution (in `rtmp-credentials-crypto.ts`):
 *   1. `RTMP_CREDENTIALS_KEY` (env) — an optional override. If set it always
 *      wins, so self-hosted setups are unchanged.
 *   2. otherwise this stored, backend-generated RTMP key.
 *
 * Scope: the RTMP stream-key crypto (`rtmp-credentials-crypto.ts`) falls back
 * here ONLY. The SRT passphrase crypto and the HTML-auth crypto fall back to the
 * separate credential-encryption key (#446) — the two key families never cross,
 * preserving ADR-004's RTMP/SRT key separation.
 *
 * The key is a credential: it is NEVER logged (redacted via the `secret`
 * substring in `src/lib/log-redact.ts` and the Fastify logger redact paths in
 * `src/server.ts`) and NEVER returned by any route.
 *
 * `rtmp-credential-key.ts` imports `db/index.ts`, which imports `config.ts` — an
 * existing cycle (see `credential-encryption-key.ts` / `guest-signing-key.ts`).
 * It is safe only because no binding is used at module-eval time; keep it that
 * way (do not call these at top level).
 */

import { randomBytes } from 'crypto';
import { getRtmpCredentialKeysDb } from '../db/index.js';
import type { RtmpCredentialKeyDoc } from '../db/types.js';

/** 32-byte AES-256 key. */
const KEY_BYTES = 32;

/**
 * Single fixed document id for the stored RTMP key — at most one per instance.
 * DISTINCT from `CREDENTIAL_ENCRYPTION_KEY_DOC_ID` (#446) so the RTMP key and the
 * SRT/credential key never share storage (ADR-004 Resolved Decision 2).
 */
export const RTMP_CREDENTIAL_KEY_DOC_ID = 'rtmp-credentials-key';

/**
 * In-memory cache of the decoded stored key, populated by
 * `ensureRtmpCredentialKey()`. `undefined` = not yet resolved; `null` = resolved
 * but intentionally absent (the `RTMP_CREDENTIALS_KEY` env override is set, so no
 * stored key is needed — see below).
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
 * Ensure a stored RTMP key exists and is cached, returning the effective decoded
 * key (or `null` when a stored key is deliberately not used).
 *
 * Called once at startup (after the DB connects). Idempotent and race-safe:
 * - `RTMP_CREDENTIALS_KEY` env override set ⇒ no stored key is needed. The DB is
 *   never touched and existing self-hosted deployments are unchanged. Returns
 *   `null`.
 * - stored doc present ⇒ read, decode and cache it;
 * - stored doc absent ⇒ generate one and `insert()` under the fixed id. If two
 *   backend processes race on first start, the loser's insert gets a `409`
 *   conflict; it re-reads and uses the winner's key, so all processes end up
 *   encrypting with the same key.
 */
export async function ensureRtmpCredentialKey(): Promise<Buffer | null> {
  // 1. The RTMP_CREDENTIALS_KEY env override makes a stored key unnecessary.
  //    Never persist anything in that case.
  if (process.env['RTMP_CREDENTIALS_KEY']) {
    cachedKey = null;
    return null;
  }
  if (cachedKey !== undefined) return cachedKey;

  const db = getRtmpCredentialKeysDb();

  // 2. Reuse the stored key if one already exists (restart / second process).
  try {
    const doc = await db.get(RTMP_CREDENTIAL_KEY_DOC_ID);
    cachedKey = decodeStoredKey(doc.encryptionSecret);
    return cachedKey;
  } catch (err) {
    if (!hasStatus(err, 404)) throw err;
  }

  // 3. First start: create the key only if absent.
  const doc: RtmpCredentialKeyDoc = {
    _id: RTMP_CREDENTIAL_KEY_DOC_ID,
    type: 'rtmp-credentials-key',
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
    const winner = await db.get(RTMP_CREDENTIAL_KEY_DOC_ID);
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
      `Stored RTMP credential key must decode to ${KEY_BYTES} bytes; got ${buf.length}`,
    );
  }
  return buf;
}

/**
 * The effective stored RTMP key, or `null` if none is available yet (no stored
 * key, or `ensureRtmpCredentialKey()` has not populated the cache — e.g. the DB
 * was unreachable at startup). Synchronous: safe on the hot path the RTMP crypto
 * module calls it from.
 */
export function getStoredRtmpCredentialKey(): Buffer | null {
  return cachedKey ?? null;
}

/** Test-only: clear the in-memory cache so each case starts from a fresh state. */
export function __resetRtmpCredentialKeyCacheForTests(): void {
  cachedKey = undefined;
}
