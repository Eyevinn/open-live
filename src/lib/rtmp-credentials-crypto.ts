/**
 * RTMP stream-key encryption-at-rest (spec: rtmp-multi-destination.md, ADR-004).
 *
 * An RTMP destination (`outputType: 'rtmp'`) carries a platform stream key — a
 * bearer credential for the operator's YouTube/Twitch/Facebook channel. It must
 * never be stored in plaintext, logged, or returned by the API. This module
 * encrypts it at rest, reusing the exact hardened house pattern established for
 * SRT passphrases (`src/lib/srt-passphrase-crypto.ts`): AES-256-GCM, a
 * self-describing `encv1:` wire prefix, fail-closed in production, loud no-op in
 * dev.
 *
 * Key: a DEDICATED `RTMP_CREDENTIALS_KEY` (ADR-004 Resolved Decision 2) — NOT a
 * reuse of / fallback to `SRT_PASSPHRASE_KEY`, so rotating the RTMP stream-key
 * key does not force an SRT-passphrase-key rotation (and vice-versa). When the
 * env var is unset the key falls back to a DEDICATED backend-generated stored
 * RTMP key (`src/lib/rtmp-credential-key.ts`, issue #447) — its OWN key, NEVER
 * the SRT/credential key (#446) — so RTMP stream keys can be saved out of the box
 * on OSC where no key env var is provisioned, while ADR-004's RTMP/SRT key
 * separation is preserved. A missing key (no env var and no stored key yet) fails
 * closed in production when a stored ciphertext exists; in non-production it
 * degrades to a loud no-op so local dev without a key works.
 *
 * NEVER log the plaintext stream key or the raw key from this module. The
 * decrypted key is composed into `rtmp_url` only at flow-generation time and is
 * never persisted composed (spec §Configuration, ADR-004 Decision 3).
 */

import {
  encryptPassphrase,
  decryptPassphrase,
  type KeySource,
} from './srt-passphrase-crypto.js';
import { getStoredRtmpCredentialKey } from './rtmp-credential-key.js';

/**
 * Dedicated key source for RTMP stream keys. Falls back to the DEDICATED stored
 * RTMP key (issue #447), never the SRT/credential key — ADR-004 Resolved
 * Decision 2 keeps RTMP and SRT key rotation isolated.
 */
export const RTMP_CREDENTIALS_KEY_SOURCE: KeySource = {
  envVar: 'RTMP_CREDENTIALS_KEY',
  allowStoredKeyFallback: true,
  storedKeyProvider: getStoredRtmpCredentialKey,
};

/**
 * Encrypt a raw RTMP stream key into an `encv1:` bundle under
 * `RTMP_CREDENTIALS_KEY`. Callers must validate the key first (reject an
 * `encv1:` prefix — see `validateStreamKey`) so a plaintext key that happens to
 * begin with `encv1:` can never bypass encryption via the double-wrap guard.
 */
export function encryptStreamKey(plaintext: string): string {
  return encryptPassphrase(plaintext, RTMP_CREDENTIALS_KEY_SOURCE);
}

/**
 * Decrypt a stored `encv1:` RTMP stream key back to plaintext. Fails closed
 * (throws) when a ciphertext exists but `RTMP_CREDENTIALS_KEY` is not set.
 */
export function decryptStreamKey(value: string): string {
  return decryptPassphrase(value, RTMP_CREDENTIALS_KEY_SOURCE);
}
