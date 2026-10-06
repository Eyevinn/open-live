/**
 * SRT passphrase encryption-at-rest (issue #160).
 *
 * SRT source addresses can embed a passphrase, e.g.
 *   srt://host:9000?passphrase=<secret>&latency=200
 * Historically the whole address (passphrase included) was stored verbatim in
 * CouchDB. This module encrypts *only* the passphrase query parameter before a
 * source doc is persisted and decrypts it again before the URL is masked for API
 * responses or handed to Strom. Host/port/other params stay in cleartext so the
 * existing srtUrl() validation and operator-facing masking keep working.
 *
 * Wire format for an encrypted passphrase value (url-safe, self-describing):
 *   encv1:<base64url(iv | tag | ciphertext)>
 *     - iv:  12 bytes (AES-GCM nonce)
 *     - tag: 16 bytes (GCM auth tag)
 *     - ciphertext: remaining bytes
 * The "encv1:" prefix lets decrypt distinguish ciphertext from legacy plaintext
 * and gives us a version handle for future scheme changes.
 *
 * Key: 32 bytes (AES-256) supplied via an env var (SRT_PASSPHRASE_KEY by
 * default), encoded as base64 or hex. Missing key fails closed in production;
 * in non-production it degrades to a loud no-op so local dev without a key
 * still works.
 *
 * The key-loading / encrypt / decrypt core is parameterised by a `KeySource`
 * (which env var to read) so other at-rest credentials — e.g. the dedicated
 * `RTMP_CREDENTIALS_KEY` for RTMP stream keys (ADR-004 Resolved Decision 2) —
 * can reuse the exact same AES-256-GCM / `encv1:` / fail-closed-in-prod contract
 * without weakening it. SRT callers keep the historic no-argument signatures.
 *
 * NEVER log the plaintext passphrase or the raw key from this module.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ConfigurationError } from './config-error.js';
import { getStoredCredentialKey } from './credential-encryption-key.js';

const SCHEME_PREFIX = 'encv1:';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Matches the passphrase param in an SRT URI query string (case-insensitive). */
const PASSPHRASE_RE = /([?&]passphrase=)([^&]*)/gi;

/**
 * Identifies which env var holds the AES-256 key for a given credential kind.
 * A dedicated source per credential kind keeps rotation blast-radius isolated
 * (ADR-004 Resolved Decision 2 — RTMP does NOT reuse `SRT_PASSPHRASE_KEY`).
 */
export interface KeySource {
  /** Env var name holding the base64/hex 32-byte key. */
  envVar: string;
  /**
   * When the env var is unset, fall back to a backend-generated stored key
   * instead of failing closed. This makes credential storage work out of the box
   * on OSC, where no key env var is provisioned.
   *
   * The fallback key comes from `storedKeyProvider` when the source sets one,
   * otherwise from the shared credential-encryption key
   * (`src/lib/credential-encryption-key.ts`, issue #438). RTMP stream keys set
   * their OWN provider (`src/lib/rtmp-credential-key.ts`, issue #447) so they
   * never read the SRT/credential key — ADR-004 Resolved Decision 2 keeps the
   * RTMP and SRT key families isolated.
   */
  allowStoredKeyFallback?: boolean;
  /**
   * Optional, dedicated accessor for the stored fallback key of this credential
   * kind. Only consulted when `allowStoredKeyFallback` is set. Lets a kind (RTMP)
   * fall back to its OWN stored key rather than the shared credential key,
   * without weakening the SRT/HTML path's default. Defaults to the shared
   * credential-encryption key accessor when unset.
   */
  storedKeyProvider?: () => Buffer | null;
}

/** Default source — the historic SRT passphrase key (falls back to the stored key). */
export const SRT_PASSPHRASE_KEY_SOURCE: KeySource = {
  envVar: 'SRT_PASSPHRASE_KEY',
  allowStoredKeyFallback: true,
};

// Per-env-var key cache so distinct credential kinds (SRT, RTMP) never collide.
const keyCache = new Map<string, Buffer | null>();

function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * Decode a 32-byte key from base64 or hex. Tries base64 first, falls back to
 * hex; both must decode to exactly KEY_BYTES. Throws with a clear (secret-free)
 * message otherwise.
 */
export function decodeKey(raw: string, envVar = 'SRT_PASSPHRASE_KEY'): Buffer {
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`${envVar} is empty`);
  }

  // Hex form: exactly 64 hex chars → 32 bytes. Check this first because a 64-char
  // hex string is also valid base64 but would decode to the wrong length.
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, 'hex');
  }

  const fromBase64 = Buffer.from(value, 'base64');
  if (fromBase64.length === KEY_BYTES) {
    return fromBase64;
  }

  throw new Error(
    `${envVar} must decode to ${KEY_BYTES} bytes (base64 or hex); ` +
      `got ${fromBase64.length} bytes after base64 decode`,
  );
}

/**
 * Load and cache the key from SRT_PASSPHRASE_KEY.
 * - Returns a 32-byte Buffer when the env var is set and valid.
 * - Throws when the value is present but malformed (regardless of environment).
 * - When the var is unset: throws in production (fail closed), returns null in
 *   non-production so local dev keeps working with plaintext.
 */
export function loadKey(source: KeySource = SRT_PASSPHRASE_KEY_SOURCE): Buffer | null {
  const cached = keyCache.get(source.envVar);
  if (cached !== undefined) return cached;

  const raw = process.env[source.envVar];
  if (!raw) {
    // No env override: for credential kinds that allow it, use the backend-
    // generated stored key so storage works on OSC where no key env var is set.
    // SRT/HTML (#438) default to the shared credential key; RTMP (#447) injects
    // its OWN `storedKeyProvider`, so the two key families never cross (ADR-004
    // Resolved Decision 2).
    if (source.allowStoredKeyFallback) {
      const stored = (source.storedKeyProvider ?? getStoredCredentialKey)();
      if (stored) {
        keyCache.set(source.envVar, stored);
        return stored;
      }
    }
    if (isProduction()) {
      // Fail closed (ADR-003 Decision 4) — never store a credential in plaintext.
      // A ConfigurationError surfaces as a clear 503 rather than a generic 500
      // (issue #349), so operators/clients can tell a misconfiguration from a bug.
      throw new ConfigurationError(
        `Credential storage is not configured on this deployment (${source.envVar}). ` +
          `Set ${source.envVar} to a 32-byte base64/hex key to store credentials at rest.`,
      );
    }
    // Non-production: allow running without a key but make the risk visible.
    // eslint-disable-next-line no-console
    console.warn(
      `[srt-crypto] ${source.envVar} is not set — credentials will be stored in plaintext. Set it before deploying.`,
    );
    keyCache.set(source.envVar, null);
    return null;
  }

  const key = decodeKey(raw, source.envVar);
  keyCache.set(source.envVar, key);
  return key;
}

/** Test-only: clear all cached keys so env changes take effect. */
export function resetKeyCache(): void {
  keyCache.clear();
}

/** True if the value is an encv1 ciphertext bundle (vs legacy plaintext). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(SCHEME_PREFIX);
}

/**
 * Encrypt a single passphrase value into an `encv1:` bundle.
 * Returns the plaintext unchanged when no key is configured (non-production
 * dev fallback) so callers can persist without special-casing.
 */
export function encryptPassphrase(plaintext: string, source: KeySource = SRT_PASSPHRASE_KEY_SOURCE): string {
  const key = loadKey(source);
  if (!key) return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted — don't double-wrap

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bundle = Buffer.concat([iv, tag, ciphertext]);
  return SCHEME_PREFIX + bundle.toString('base64url');
}

/**
 * Decrypt an `encv1:` bundle back to plaintext.
 * Legacy plaintext (no `encv1:` prefix) is returned unchanged so existing docs
 * that predate encryption keep working.
 * Throws on tampering (GCM auth failure) or a malformed bundle.
 */
export function decryptPassphrase(value: string, source: KeySource = SRT_PASSPHRASE_KEY_SOURCE): string {
  if (!isEncrypted(value)) return value; // legacy plaintext pass-through

  const key = loadKey(source);
  if (!key) {
    // Fail closed — a stored ciphertext exists but no key is configured. Never
    // fall through to returning the ciphertext or an empty string (ADR-004).
    throw new Error(
      `Encountered an encrypted credential but ${source.envVar} is not set`,
    );
  }

  const bundle = Buffer.from(value.slice(SCHEME_PREFIX.length), 'base64url');
  if (bundle.length < IV_BYTES + TAG_BYTES) {
    throw new Error('Malformed encrypted SRT passphrase: bundle too short');
  }
  const iv = bundle.subarray(0, IV_BYTES);
  const tag = bundle.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bundle.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Encrypt the passphrase param(s) inside an SRT address for storage.
 * Non-SRT addresses and addresses without a passphrase are returned unchanged.
 */
export function encryptAddressPassphrase(address: string): string {
  return address.replace(PASSPHRASE_RE, (_m, prefix: string, secret: string) => {
    if (secret.length === 0) return prefix; // nothing to encrypt
    return prefix + encryptPassphrase(secret);
  });
}

/**
 * Decrypt the passphrase param(s) inside a stored SRT address back to plaintext
 * for masking in API responses or for handing to Strom. Legacy plaintext values
 * pass through unchanged.
 */
export function decryptAddressPassphrase(address: string): string {
  return address.replace(PASSPHRASE_RE, (_m, prefix: string, secret: string) => {
    if (secret.length === 0) return prefix;
    return prefix + decryptPassphrase(secret);
  });
}
