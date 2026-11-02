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

// --------------- SigV4 request signing (dependency-free) ---------------

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

/** The connection fields a SigV4 signature needs — a `MinioTarget` minus the bucket. */
export type S3Credentials = Pick<MinioTarget, 'endpoint' | 'useSsl' | 'region' | 'accessKey' | 'secretKey'>;

/**
 * Builds the URL + headers of a SigV4-signed (service `s3`, the connection's
 * region), empty-body `GET` for an arbitrary already-encoded `canonicalUri`
 * (e.g. `/my-bucket` or `/minio/admin/v3/storageinfo`) and query. Query entries
 * are RFC 3986-encoded and sorted as SigV4 requires; a valueless sub-resource is
 * passed as `{ name: '' }`. Pure — the caller performs the request.
 */
export function signS3GetRequest(
  creds: S3Credentials,
  canonicalUri: string,
  query: Record<string, string> = {},
  now: Date = new Date(),
): { url: string; headers: Record<string, string> } {
  const scheme = creds.useSsl ? 'https' : 'http';
  const host = creds.endpoint;

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
    .join('&');

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${creds.region}/s3/aws4_request`;

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

  const kDate = hmac(`AWS4${creds.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, creds.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `${algorithm} Credential=${creds.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${scheme}://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': EMPTY_SHA256,
      Authorization: authorization,
    },
  };
}

/** Sends a SigV4-signed GET; returns the raw HTTP status + body. Throws on network error/abort. */
async function signedGet(
  creds: S3Credentials,
  canonicalUri: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; body: string }> {
  const { url, headers } = signS3GetRequest(creds, canonicalUri, query);
  const res = await fetch(url, { method: 'GET', headers, ...(signal ? { signal } : {}) });
  const body = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, body };
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
  signal?: AbortSignal,
): Promise<{ status: number; ok: boolean; body: string }> {
  const query: Record<string, string> = {
    'list-type': '2',
    'max-keys': String(params.maxKeys),
  };
  if (params.delimiter) query['delimiter'] = params.delimiter;
  if (params.prefix) query['prefix'] = params.prefix;
  if (params.continuationToken) query['continuation-token'] = params.continuationToken;
  return signedGet(target, encodeBucketPath(target.bucket), query, signal);
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

// --------------- Capacity (MinIO admin storageinfo + bucket quota) ---------------

/**
 * Reference bitrate for the recording-minutes estimate: the Enc PGM default
 * (`builtin.videoenc` `bitrate: 10000` kbps in `default-flow.ts`), which feeds
 * the recorder's video (`flow-generator.ts`, Live Recorder branch).
 */
export const REFERENCE_BITRATE_KBPS = 10000;

/** Per-upstream-request timeout for the capacity probe. */
export const CAPACITY_TIMEOUT_MS = 5000;

/** How long a capacity result is reused per connection id. */
export const CAPACITY_CACHE_TTL_MS = 30_000;

export type StorageCapacityResult =
  | {
      status: 'available';
      totalBytes: number;
      freeBytes: number;
      scope: 'server' | 'bucket-quota';
      referenceBitrateKbps: number;
      estimatedMinutes: number;
      checkedAt: string;
    }
  | {
      status: 'unavailable';
      reason: 'forbidden' | 'not-supported' | 'unreachable';
      checkedAt: string;
    };

/** A connection's signing credentials plus its default bucket (if any). */
export interface StorageConnectionCredentials {
  creds: S3Credentials;
  defaultBucket?: string;
}

/**
 * Resolves a connection id to its signing credentials without requiring a
 * bucket (capacity is a server-level query). `"default"` maps to the env
 * connection and, like `GET /:id`, does not resolve when env storage is not
 * configured. Throws {@link StorageConnectionNotFoundError} when the id does not
 * resolve.
 */
export async function resolveStorageCredentials(connectionId: string): Promise<StorageConnectionCredentials> {
  if (connectionId === DEFAULT_CONNECTION_ID) {
    const t = minioTargetFromConfig();
    if (!t) throw new StorageConnectionNotFoundError(connectionId);
    const { bucket, ...creds } = t;
    return { creds, defaultBucket: bucket };
  }
  let doc: StorageConnectionDoc;
  try {
    doc = await getStorageConnectionsDb().get(connectionId);
  } catch {
    throw new StorageConnectionNotFoundError(connectionId);
  }
  return {
    creds: {
      endpoint: doc.endpoint,
      useSsl: doc.useSsl,
      region: doc.region,
      accessKey: doc.accessKey,
      secretKey: decryptStorageSecret(doc.secretKeyEnc),
    },
    ...(doc.defaultBucket ? { defaultBucket: doc.defaultBucket } : {}),
  };
}

type UnavailableReason = 'forbidden' | 'not-supported' | 'unreachable';

class CapacityUnavailable extends Error {
  constructor(readonly reason: UnavailableReason) {
    super(reason);
    this.name = 'CapacityUnavailable';
  }
}

/** True for an AWS S3 endpoint — it has no admin API, so capacity is not supported. */
function isAwsEndpoint(endpoint: string): boolean {
  const host = endpoint.replace(/:\d+$/, '').toLowerCase();
  return host === 'amazonaws.com' || host.endsWith('.amazonaws.com');
}

/** Maps a non-2xx admin-API status to an unavailable reason. */
function reasonForStatus(status: number): UnavailableReason {
  if (status === 401 || status === 403) return 'forbidden';
  if (status >= 500 && status !== 501) return 'unreachable';
  return 'not-supported';
}

/** SigV4-signed admin GET with a timeout; network error / abort → `unreachable`. */
async function adminGet(
  creds: S3Credentials,
  path: string,
  query: Record<string, string> = {},
): Promise<{ status: number; ok: boolean; body: string }> {
  try {
    return await signedGet(creds, path, query, AbortSignal.timeout(CAPACITY_TIMEOUT_MS));
  } catch {
    throw new CapacityUnavailable('unreachable');
  }
}

interface MadminDisk {
  totalspace?: unknown;
  availspace?: unknown;
}
interface MadminStorageInfo {
  Disks?: unknown;
  Backend?: { Type?: unknown; StandardSCData?: unknown; StandardSCParities?: unknown };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Parses a madmin `StorageInfo` body into usable `{ total, free }` bytes. Raw
 * sums over `Disks[]`; on an erasure backend with standard-class data/parity
 * counts, both are scaled by `data / (data + parity)`. Returns null for a body
 * that is not a madmin StorageInfo (→ not-supported).
 */
export function parseStorageInfo(body: string): { total: number; free: number } | null {
  let info: MadminStorageInfo;
  try {
    info = JSON.parse(body) as MadminStorageInfo;
  } catch {
    return null;
  }
  if (!info || typeof info !== 'object' || !Array.isArray(info.Disks)) return null;
  let total = 0;
  let free = 0;
  for (const d of info.Disks as MadminDisk[]) {
    if (!d || typeof d !== 'object') continue;
    total += num(d.totalspace);
    free += num(d.availspace);
  }
  // madmin BackendType: 0 Unknown, 1 FS, 2 Erasure (serialised as an int).
  const type = info.Backend?.Type;
  const isErasure = type === 2 || (typeof type === 'string' && type.toLowerCase() === 'erasure');
  const data = Array.isArray(info.Backend?.StandardSCData) ? num(info.Backend!.StandardSCData[0]) : 0;
  const parity = Array.isArray(info.Backend?.StandardSCParities)
    ? (info.Backend!.StandardSCParities[0] as unknown)
    : undefined;
  if (isErasure && data > 0 && typeof parity === 'number' && Number.isFinite(parity) && parity >= 0) {
    const ratio = data / (data + parity);
    total = Math.floor(total * ratio);
    free = Math.floor(free * ratio);
  }
  return { total, free };
}

/** Returns the bucket's hard-quota size in bytes, or 0 when unset / any error. */
async function fetchBucketQuota(creds: S3Credentials, bucket: string): Promise<number> {
  try {
    const res = await adminGet(creds, '/minio/admin/v3/get-bucket-quota', { bucket });
    if (!res.ok) return 0;
    const parsed = JSON.parse(res.body) as { size?: unknown; quota?: unknown };
    return num(parsed.size) || num(parsed.quota);
  } catch {
    return 0;
  }
}

/**
 * Sums object sizes over one recursive ListObjectsV2 page capped at `maxKeys`.
 * Returns null when the listing fails or is truncated (usage unknown).
 */
async function fetchBucketUsage(creds: S3Credentials, bucket: string, maxKeys: number): Promise<number | null> {
  let res: { status: number; ok: boolean; body: string };
  try {
    res = await fetchListObjects({ ...creds, bucket }, { maxKeys }, AbortSignal.timeout(CAPACITY_TIMEOUT_MS));
  } catch {
    return null;
  }
  if (!res.ok || /<IsTruncated>true<\/IsTruncated>/.test(res.body)) return null;
  let used = 0;
  for (const m of res.body.matchAll(/<Contents>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
    used += Number(m[1]);
  }
  return used;
}

/**
 * Probes a connection's free space through the MinIO admin API (spec §2.8a).
 * Never throws: every upstream failure becomes an `unavailable` result, and
 * neither the result nor any error carries the secret key.
 */
export async function getStorageCapacity(
  conn: StorageConnectionCredentials,
  opts: { maxKeys: number },
): Promise<StorageCapacityResult> {
  const checkedAt = new Date().toISOString();
  try {
    if (isAwsEndpoint(conn.creds.endpoint)) throw new CapacityUnavailable('not-supported');

    const res = await adminGet(conn.creds, '/minio/admin/v3/storageinfo');
    if (!res.ok) throw new CapacityUnavailable(reasonForStatus(res.status));
    const server = parseStorageInfo(res.body);
    if (!server) throw new CapacityUnavailable('not-supported');

    let totalBytes = server.total;
    let freeBytes = server.free;
    let scope: 'server' | 'bucket-quota' = 'server';

    if (conn.defaultBucket) {
      const quota = await fetchBucketQuota(conn.creds, conn.defaultBucket);
      if (quota > 0) {
        const used = await fetchBucketUsage(conn.creds, conn.defaultBucket, opts.maxKeys);
        if (used !== null) {
          totalBytes = quota;
          freeBytes = Math.max(0, Math.min(server.free, quota - used));
          scope = 'bucket-quota';
        }
      }
    }

    return {
      status: 'available',
      totalBytes,
      freeBytes,
      scope,
      referenceBitrateKbps: REFERENCE_BITRATE_KBPS,
      estimatedMinutes: Math.floor((freeBytes * 8) / (REFERENCE_BITRATE_KBPS * 1000) / 60),
      checkedAt,
    };
  } catch (err) {
    const reason = err instanceof CapacityUnavailable ? err.reason : 'unreachable';
    return { status: 'unavailable', reason, checkedAt };
  }
}

const capacityCache = new Map<string, { expiresAt: number; result: Promise<StorageCapacityResult> }>();

/**
 * {@link getStorageCapacity} memoised per connection id for
 * {@link CAPACITY_CACHE_TTL_MS}, so a list view polling every connection does not
 * hammer the object store. Concurrent calls share one in-flight probe.
 */
export function getStorageCapacityCached(
  connectionId: string,
  conn: StorageConnectionCredentials,
  opts: { maxKeys: number },
): Promise<StorageCapacityResult> {
  const now = Date.now();
  const hit = capacityCache.get(connectionId);
  if (hit && hit.expiresAt > now) return hit.result;
  const result = getStorageCapacity(conn, opts);
  capacityCache.set(connectionId, { expiresAt: now + CAPACITY_CACHE_TTL_MS, result });
  return result;
}

/** Drops a cached capacity result (on connection update/delete), or all when no id is given. */
export function clearStorageCapacityCache(connectionId?: string): void {
  if (connectionId === undefined) capacityCache.clear();
  else capacityCache.delete(connectionId);
}
