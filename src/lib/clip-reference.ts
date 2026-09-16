/**
 * Typed, versioned clip-reference contract for `streamType: 'clip'` sources
 * (issue #275, epic #206). See `docs/specs/clip-story-playback.md`
 * §"Clip source model" / §"Migration".
 *
 * The reference is a discriminated union (`url` / `s3` / `tams`) exposed at the
 * API/zod contract level. It is persisted **serialized as a JSON string** in the
 * existing optional `SourceDoc.address` field — no persisted schema change.
 *
 * v1 scope:
 * - `url` and `s3` are implemented and validated.
 * - `tams` is accepted at the type level but rejected at runtime (501); the
 *   schema must not preclude it so the contract can grow without a breaking change.
 * - No variant assumes a fixed media length — any reference may carry an optional
 *   `timerange`.
 */

import { z } from 'zod';
import { httpUrlOnly } from './url-validation.js';
import type {
  ClipReference,
  ClipReferenceS3,
  ClipReferenceTams,
  ClipReferenceUrl,
} from '../db/types.js';

/** Thrown when a `tams` reference is used in v1 (mapped to HTTP 501 by callers). */
export class ClipReferenceNotImplementedError extends Error {
  readonly statusCode = 501;
  constructor(message = 'Clip reference type "tams" is reserved and not implemented in v1') {
    super(message);
    this.name = 'ClipReferenceNotImplementedError';
  }
}

/**
 * A `timerange` is optional on every variant and carries no fixed-length
 * assumption. Kept intentionally permissive at the contract level (a non-empty,
 * bounded string) — precise TAMS timerange grammar is deferred to the reserved
 * `tams` implementation.
 */
const timerangeSchema = z.string().min(1).max(256);

const clipReferenceUrlSchema = z.object({
  type: z.literal('url'),
  url: z.string().min(1),
  timerange: timerangeSchema.optional(),
});

const clipReferenceS3Schema = z.object({
  type: z.literal('s3'),
  bucket: z.string().min(1).max(256),
  key: z.string().min(1).max(1024),
  timerange: timerangeSchema.optional(),
});

const clipReferenceTamsSchema = z.object({
  type: z.literal('tams'),
  store: z.string().min(1),
  flowId: z.string().min(1),
  timerange: timerangeSchema,
});

/**
 * Structural zod schema for the full `ClipReference` union. This validates the
 * *shape* only — variant-specific semantic checks (URL SSRF, S3 bucket/key,
 * tams-not-implemented) live in {@link validateClipReference}.
 */
export const clipReferenceSchema: z.ZodType<ClipReference> = z.discriminatedUnion('type', [
  clipReferenceUrlSchema,
  clipReferenceS3Schema,
  clipReferenceTamsSchema,
]);

// S3 object keys: printable ASCII, no control chars, no leading slash. Bucket
// names follow the common S3/MinIO DNS-compatible rule set (3–63 chars,
// lowercase alnum plus dots/hyphens, must start and end alphanumeric).
const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_KEY_CONTROL_RE = /[\x00-\x1f\x7f]/;

/** Throws if the bucket name is not a valid S3/MinIO bucket name. */
function assertS3Bucket(bucket: string): void {
  if (!S3_BUCKET_RE.test(bucket)) {
    throw new Error(
      `Invalid S3 bucket "${bucket}" — must be 3–63 chars, lowercase alphanumeric with dots/hyphens, starting and ending alphanumeric`,
    );
  }
  // Disallow dotted-quad IP-address-shaped bucket names (rejected by S3).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bucket)) {
    throw new Error(`Invalid S3 bucket "${bucket}" — must not be formatted as an IP address`);
  }
}

/** Throws if the object key is empty, too long, or contains control characters / a leading slash. */
function assertS3Key(key: string): void {
  if (S3_KEY_CONTROL_RE.test(key)) {
    throw new Error('Invalid S3 key — control characters are not allowed');
  }
  if (key.startsWith('/')) {
    throw new Error('Invalid S3 key — must not start with "/"');
  }
}

/**
 * Applies variant-specific semantic validation to an already-shape-validated
 * clip reference:
 * - `url`  → `httpUrlOnly` (http/https only, SSRF/private-IP blocked).
 * - `s3`   → bucket/key format validation.
 * - `tams` → rejected with {@link ClipReferenceNotImplementedError} (501).
 *
 * Throws on any failure. Returns the reference unchanged on success so it can be
 * used inline.
 */
export function validateClipReference(ref: ClipReference): ClipReference {
  switch (ref.type) {
    case 'url':
      httpUrlOnly(ref.url);
      return ref;
    case 's3':
      assertS3Bucket(ref.bucket);
      assertS3Key(ref.key);
      return ref;
    case 'tams':
      throw new ClipReferenceNotImplementedError();
    default: {
      // Exhaustiveness guard — a new variant must be handled explicitly.
      const _never: never = ref;
      throw new Error(`Unknown clip reference type: ${JSON.stringify(_never)}`);
    }
  }
}

/**
 * Parses (shape) and validates (semantics) a clip reference in one step.
 * Throws a `ZodError` on a malformed shape or an `Error` on a semantic failure.
 */
export function parseClipReference(input: unknown): ClipReference {
  const ref = clipReferenceSchema.parse(input);
  return validateClipReference(ref);
}

/**
 * Serializes a clip reference to the JSON string stored in `SourceDoc.address`.
 * The reference is validated first so an invalid reference is never persisted.
 */
export function serializeClipReference(ref: ClipReference): string {
  validateClipReference(ref);
  return JSON.stringify(ref);
}

/**
 * Deserializes and validates a clip reference from a `SourceDoc.address` JSON
 * string. Throws on malformed JSON, an invalid shape, or a semantic failure.
 */
export function deserializeClipReference(address: string): ClipReference {
  let parsed: unknown;
  try {
    parsed = JSON.parse(address);
  } catch {
    throw new Error('Invalid clip reference — address is not valid JSON');
  }
  return parseClipReference(parsed);
}

export type { ClipReference, ClipReferenceUrl, ClipReferenceS3, ClipReferenceTams };
