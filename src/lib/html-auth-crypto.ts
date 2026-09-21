/**
 * Authenticated-HTML-source credential encryption-at-rest (issue #314,
 * `docs/specs/authenticated-html-sources.md`, ADR-003 Decision 2 & 4).
 *
 * An authenticated HTML source (`streamType: 'html'`) may carry a stored
 * credential — a static navigation header value (Design B) — that the
 * server-side renderer would apply. That value is a provider secret and must
 * never be stored in plaintext, logged, or returned by the API. This module
 * encrypts it at rest, reusing the exact house pattern established for SRT
 * passphrases (`src/lib/srt-passphrase-crypto.ts`): AES-256-GCM, a
 * self-describing `encv1:` wire prefix, fail-closed in production.
 *
 * Wire format (url-safe, self-describing) — identical scheme to srt-passphrase:
 *   encv1:<base64url(iv | tag | ciphertext)>
 *     - iv:  12 bytes (AES-GCM nonce, fresh random per encrypt)
 *     - tag: 16 bytes (GCM auth tag)
 *     - ciphertext: remaining bytes
 *
 * ADR-003 Decision 4 hardening carried into Phase 2:
 *   - a fresh random 12-byte GCM nonce per encrypt (randomBytes below);
 *   - the owning source id is bound to the ciphertext as GCM AAD, so a
 *     ciphertext copied onto a different source fails to decrypt (auth-tag
 *     mismatch) rather than silently decrypting under another source;
 *   - fail-closed when a stored secret exists but cannot be decrypted (wrong or
 *     rotated key) — decrypt throws, callers must never fall through to
 *     plaintext or empty.
 *
 * Key: 32 bytes (AES-256) from `HTML_AUTH_KEY`, encoded base64 or hex. Falls
 * back to `SRT_PASSPHRASE_KEY` when `HTML_AUTH_KEY` is unset so existing
 * deployments keep working (spec §Configuration / ADR-003 OQ3). A missing key
 * fails closed in production; in non-production it degrades to a loud no-op so
 * local dev without a key still works (mirroring srt-passphrase-crypto).
 *
 * NEVER log the plaintext credential or the raw key from this module.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { decodeKey } from './srt-passphrase-crypto.js';

const SCHEME_PREFIX = 'encv1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null | undefined;

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * Load and cache the HTML-auth key.
 * - `HTML_AUTH_KEY` is preferred; falls back to `SRT_PASSPHRASE_KEY` (ADR-003 OQ3).
 * - Throws when a value is present but malformed (any environment).
 * - When neither var is set: throws in production (fail closed), returns null in
 *   non-production so local dev keeps working without a key.
 */
export function loadHtmlAuthKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;

  const raw = process.env['HTML_AUTH_KEY'] ?? process.env['SRT_PASSPHRASE_KEY'];
  if (!raw) {
    if (isProduction()) {
      throw new Error(
        'HTML_AUTH_KEY (or SRT_PASSPHRASE_KEY fallback) is required in production to encrypt HTML-source auth material at rest',
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[html-auth-crypto] neither HTML_AUTH_KEY nor SRT_PASSPHRASE_KEY is set — HTML source auth material will be stored in plaintext. Set it before deploying.',
    );
    cachedKey = null;
    return cachedKey;
  }

  cachedKey = decodeKey(raw);
  return cachedKey;
}

/** Test-only: clear the cached key so env changes take effect. */
export function resetHtmlAuthKeyCache(): void {
  cachedKey = undefined;
}

/** True if the value is an encv1 ciphertext bundle (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(SCHEME_PREFIX);
}

/**
 * Encrypt an HTML-source credential value into an `encv1:` bundle, binding it to
 * its owning source id via GCM AAD (ADR-003 Decision 4). Returns the plaintext
 * unchanged when no key is configured (non-production dev fallback) so callers
 * can persist without special-casing.
 */
export function encryptHtmlAuthValue(plaintext: string, sourceId: string): string {
  const key = loadHtmlAuthKey();
  if (!key) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted — don't double-wrap

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(sourceId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bundle = Buffer.concat([iv, tag, ciphertext]);
  return SCHEME_PREFIX + bundle.toString('base64url');
}

/**
 * Decrypt an `encv1:` bundle back to plaintext, verifying the source-id AAD.
 * Legacy plaintext (no `encv1:` prefix) is returned unchanged. Throws on
 * tampering, a mismatched source id (AAD), a malformed bundle, or a missing key
 * when a stored ciphertext exists — the caller must fail closed, never falling
 * through to plaintext/empty (ADR-003 Decision 4).
 */
export function decryptHtmlAuthValue(value: string, sourceId: string): string {
  if (!isEncrypted(value)) return value; // legacy plaintext pass-through

  const key = loadHtmlAuthKey();
  if (!key) {
    throw new Error(
      'Encountered encrypted HTML-source auth material but HTML_AUTH_KEY/SRT_PASSPHRASE_KEY is not set',
    );
  }

  const bundle = Buffer.from(value.slice(SCHEME_PREFIX.length), 'base64url');
  if (bundle.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Malformed encrypted HTML-source auth material: bundle too short');
  }
  const iv = bundle.subarray(0, IV_BYTES);
  const tag = bundle.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bundle.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(sourceId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
