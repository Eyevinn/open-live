/**
 * Storage-connection secret-key encryption-at-rest (issue #520, OL-21, ADR-009
 * Decision 1).
 *
 * A `StorageConnectionDoc` stores an object-store secret access key — a
 * high-value credential (it can read clips and write recordings). It must never
 * be stored in plaintext, returned by the API, or logged. This module encrypts
 * it at rest reusing the exact house pattern established for SRT passphrases
 * (`src/lib/srt-passphrase-crypto.ts`): AES-256-GCM, the self-describing `encv1:`
 * wire prefix, fail-closed in production.
 *
 * Key source (ADR-009 Decision 1 — the SHARED credential-encryption key family,
 * like SRT/HTML, NOT RTMP's isolated family):
 *   1. `STORAGE_CONNECTION_KEY` (env) — an optional, self-hosted override that
 *      always wins when set, so operators can pin/rotate storage independently.
 *   2. otherwise the shared backend-generated credential-encryption key
 *      (`src/lib/credential-encryption-key.ts`, issue #438) — the same key SRT
 *      and HTML already fall back to, so OSC instances stay zero-config.
 *
 * Storage secrets deliberately do NOT get an isolated stored-key family like
 * RTMP's `RTMP_CREDENTIALS_KEY`: object-store credentials sit in the same trust
 * tier as SRT passphrases, and the shared family keeps the stored-key surface to
 * one key on OSC. An operator who still wants isolation sets
 * `STORAGE_CONNECTION_KEY` (ADR-009 Alternatives).
 *
 * NB: a self-hosted deployment that sets `SRT_PASSPHRASE_KEY` (which suppresses
 * the shared stored key — see `credential-encryption-key.ts`) but leaves
 * `STORAGE_CONNECTION_KEY` unset has no key for storage secrets and fails closed
 * in production; such deployments must also set `STORAGE_CONNECTION_KEY`.
 *
 * NEVER log the plaintext secret key or the raw key from this module.
 */

import {
  type KeySource,
  encryptPassphrase,
  decryptPassphrase,
} from './srt-passphrase-crypto.js';

/**
 * Key source for storage-connection secrets: the `STORAGE_CONNECTION_KEY` env
 * override, falling back to the SHARED backend-generated credential key (no
 * dedicated `storedKeyProvider`, exactly like the SRT/HTML family).
 */
export const STORAGE_CONNECTION_KEY_SOURCE: KeySource = {
  envVar: 'STORAGE_CONNECTION_KEY',
  allowStoredKeyFallback: true,
};

/** Encrypt a storage secret key into an `encv1:` bundle (never double-wraps). */
export function encryptStorageSecret(plaintext: string): string {
  return encryptPassphrase(plaintext, STORAGE_CONNECTION_KEY_SOURCE);
}

/** Decrypt an `encv1:` storage secret bundle back to plaintext (fail-closed). */
export function decryptStorageSecret(value: string): string {
  return decryptPassphrase(value, STORAGE_CONNECTION_KEY_SOURCE);
}
