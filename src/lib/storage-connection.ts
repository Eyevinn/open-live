/**
 * Storage-connection resolution, object-listing, and test-probe helpers (issue
 * #520, OL-21, `docs/specs/storage-connections.md`, ADR-009).
 *
 * A `StorageConnectionDoc` maps 1:1 onto a `MinioTarget` once its `secretKeyEnc`
 * is decrypted and a bucket is supplied, so the existing dependency-free SigV4
 * signer (`src/lib/recording-uploader.ts`) is reused with a per-connection
 * target instead of `minioTargetFromConfig()`. open-live always holds the
 * credentials; only short-lived presigned URLs ever leave the backend.
 *
 * The reserved id `"default"` is never a stored document — it denotes the
 * env-derived connection, materialised on demand from `minioTargetFromConfig()`
 * (spec §3.2). `resolveStorageTarget()` is the single resolver used by the clip,
 * recording-upload, and recording-playback paths.
 */

import { createHash, createHmac } from 'crypto';
import { getStorageConnectionsDb } from '../db/index.js';
import type { StorageConnectionDoc } from '../db/types.js';
import {
  minioTargetFromConfig,
  detectS3AuthError,
  type MinioTarget,
} from './recording-uploader.js';
import { decryptStorageSecret } from './storage-connection-crypto.js';

/** The reserved id for the implicit env-derived default connection. */
export const DEFAULT_CONNECTION_ID = 'default';

/** Thrown when a referenced storage connection id does not resolve (→ 404). */
export class StorageConnectionNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) {
    super(`Storage connection "${id}" not found`);
    this.name = 'StorageConnectionNotFoundError';
  }
}

/** Object-store listing failure, classified so routes can map it to a status. */
export class StorageListError extends Error {
  constructor(
    readonly kind: 'forbidden' | 'bucket-not-found' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'StorageListError';
  }
}

/**
 * Builds a `MinioTarget` from a stored connection doc (secret decrypted) plus a
 * bucket. Returns null when no bucket can be determined (`bucketOverride` and
 * `defaultBucket` both absent), mirroring `minioTargetFromConfig()`'s null
 * contract so callers treat it as "not resolvable".
 */
export function targetFromConnectionDoc(
  doc: StorageConnectionDoc,
  bucketOverride?: string,
): MinioTarget | null {
  const bucket = bucketOverride || doc.defaultBucket;
  if (!bucket) return null;
  return {
    endpoint: doc.endpoint,
    useSsl: doc.useSsl,
    region: doc.region,
    accessKey: doc.accessKey,
    secretKey: decryptStorageSecret(doc.secretKeyEnc),
    bucket,
  };
}

/**
 * Resolves `(connectionId?, bucketOverride?)` to a `MinioTarget`, the single
 * resolver for the clip, recording-upload, and recording-playback paths
 * (spec §3.2):
 *   - a real `connectionId` → load the doc, decrypt the secret, map to a target
 *     (bucket = `bucketOverride ?? doc.defaultBucket`);
 *   - absent / `"default"` → `minioTargetFromConfig(bucketOverride)`, unchanged
 *     default behaviour.
 *
 * Throws {@link StorageConnectionNotFoundError} when a given `connectionId` does
 * not resolve; returns null when the target cannot be built (no bucket, or the
 * env default is not configured).
 */
export async function resolveStorageTarget(
  connectionId?: string,
  bucketOverride?: string,
): Promise<MinioTarget | null> {
  if (connectionId && connectionId !== DEFAULT_CONNECTION_ID) {
    let doc: StorageConnectionDoc;
    try {
      doc = await getStorageConnectionsDb().get(connectionId);
    } catch {
      throw new StorageConnectionNotFoundError(connectionId);
    }
    return targetFromConnectionDoc(doc, bucketOverride);
  }
  return minioTargetFromConfig(bucketOverride);
}

// --------------- SigV4-signed ListObjectsV2 (dependency-free) ---------------

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 percent-encoding, as required for the SigV4 canonical query string. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Encodes an object-key path segment-by-segment for an S3 URI (path-style). */
function encodeBucketPath(bucket: string): string {
  return '/' + bucket.split('/').map(encodeURIComponent).join('/');
}

interface ListParams {
  prefix?: string;
  delimiter?: string;
  maxKeys: number;
  continuationToken?: string;
}

/** SigV4-signed ListObjectsV2 GET; returns the raw HTTP status + body. */
async function fetchListObjects(
  target: MinioTarget,
  params: ListParams,
  now: Date = new Date(),
): Promise<{ status: number; ok: boolean; body: string }> {
  const scheme = target.useSsl ? 'https' : 'http';
  const host = target.endpoint;
  const canonicalUri = encodeBucketPath(target.bucket);

  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': String(params.maxKeys),
  };
  if (params.delimiter) query['delimiter'] = params.delimiter;
  if (params.prefix) query['prefix'] = params.prefix;
  if (params.continuationToken) query['continuation-token'] = params.continuationToken;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
    .join('&');

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${EMPTY_SHA256}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n');

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${target.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, target.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `${algorithm} Credential=${target.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${scheme}://${host}${canonicalUri}?${canonicalQuery}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': EMPTY_SHA256,
      Authorization: authorization,
    },
  });
  const body = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, body };
}

/** Decodes the five predefined XML entities that may appear in a key/prefix. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface StorageObject {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}
export interface StorageFolder {
  prefix: string;
}
export interface StorageListPage {
  bucket: string;
  prefix: string;
  folders: StorageFolder[];
  objects: StorageObject[];
  cursor?: string;
}

/**
 * Read-only, delimiter-scoped (no recursion), cursor-paged object listing for a
 * resolved target (spec §2.8). Credentials are never surfaced. Classifies S3
 * errors into {@link StorageListError} kinds so the route can map them to
 * 403 / 404 / 502.
 */
export async function listStorageObjects(
  target: MinioTarget,
  opts: { prefix: string; cursor?: string; maxKeys: number },
): Promise<StorageListPage> {
  let res: { status: number; ok: boolean; body: string };
  try {
    res = await fetchListObjects(target, {
      prefix: opts.prefix,
      delimiter: '/',
      maxKeys: opts.maxKeys,
      continuationToken: opts.cursor,
    });
  } catch {
    throw new StorageListError('unreachable', 'Object store unreachable');
  }

  if (!res.ok) {
    const code = detectS3AuthError(res.status, res.body);
    if (code === 'AccessDenied' || res.status === 403) {
      throw new StorageListError('forbidden', 'The storage key lacks list permission (AccessDenied)');
    }
    if (res.status === 404 || res.body.includes('NoSuchBucket')) {
      throw new StorageListError('bucket-not-found', 'Bucket not found');
    }
    if (code) {
      // An auth/credential rejection (InvalidAccessKeyId / SignatureDoesNotMatch)
      // on a route whose API gate already passed — treat as a list denial.
      throw new StorageListError('forbidden', `The storage key was rejected (${code})`);
    }
    throw new StorageListError('unreachable', `Object store error (status ${res.status})`);
  }

  const folders: StorageFolder[] = [];
  for (const m of res.body.matchAll(/<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g)) {
    folders.push({ prefix: decodeXml(m[1]!) });
  }

  const objects: StorageObject[] = [];
  for (const m of res.body.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]!;
    const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1] ?? '');
    if (!key) continue;
    const size = Number(/<Size>(\d+)<\/Size>/.exec(block)?.[1] ?? '0');
    const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(block)?.[1] ?? '';
    const name = key.endsWith('/') ? key.slice(0, -1).split('/').pop() ?? key : key.split('/').pop() ?? key;
    objects.push({ key, name, size, lastModified });
  }

  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(res.body)?.[1];
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(res.body);

  const page: StorageListPage = { bucket: target.bucket, prefix: opts.prefix, folders, objects };
  if (truncated && next) page.cursor = decodeXml(next);
  return page;
}

// --------------- Test-connection probe ---------------

export interface TestConnectionResult {
  checkedFrom: 'open-live';
  reachable: boolean;
  auth: 'ok' | 'failed' | 'forbidden';
  bucket: 'found' | 'not-found' | 'unchecked';
  canList: boolean;
  message: string;
  note?: string;
}

/**
 * Credential-exercising probe (a `max-keys=1` ListObjectsV2) against a resolved
 * target, classifying the outcome into a structured result (spec §2.7). Always
 * probed from open-live — the authoritative side; a `from:"strom"` request is
 * accepted but answered with `checkedFrom:"open-live"` + a `note`, per OQ3
 * (Strom-side reachability is an unverified cross-service capability).
 */
export async function testStorageConnection(
  target: MinioTarget,
  opts: { from?: 'open-live' | 'strom' } = {},
): Promise<TestConnectionResult> {
  const base: Pick<TestConnectionResult, 'checkedFrom'> & { note?: string } = { checkedFrom: 'open-live' };
  if (opts.from === 'strom') {
    base.note = 'Strom-side check unavailable; probed from open-live.';
  }

  let res: { status: number; ok: boolean; body: string };
  try {
    res = await fetchListObjects(target, { maxKeys: 1 });
  } catch {
    return {
      ...base,
      reachable: false,
      auth: 'failed',
      bucket: 'unchecked',
      canList: false,
      message: 'Endpoint unreachable (DNS/connect/TLS).',
    };
  }

  if (res.ok) {
    return {
      ...base,
      reachable: true,
      auth: 'ok',
      bucket: 'found',
      canList: true,
      message: `Reached endpoint; credentials valid; bucket '${target.bucket}' found.`,
    };
  }

  if (res.status === 404 || res.body.includes('NoSuchBucket')) {
    return {
      ...base,
      reachable: true,
      auth: 'ok',
      bucket: 'not-found',
      canList: false,
      message: `Bucket '${target.bucket}' not found.`,
    };
  }

  const code = detectS3AuthError(res.status, res.body);
  if (code === 'AccessDenied') {
    return {
      ...base,
      reachable: true,
      auth: 'forbidden',
      bucket: 'unchecked',
      canList: false,
      message: `Reached endpoint; credentials valid but the key lacks list permission on '${target.bucket}' (AccessDenied).`,
    };
  }
  if (code) {
    return {
      ...base,
      reachable: true,
      auth: 'failed',
      bucket: 'unchecked',
      canList: false,
      message: `Authentication failed (${code}).`,
    };
  }
  return {
    ...base,
    reachable: true,
    auth: 'failed',
    bucket: 'unchecked',
    canList: false,
    message: `Unexpected response from the object store (status ${res.status}).`,
  };
}
