/**
 * VOD recording uploader — upload-from-local path (epic #5, issue #41).
 *
 * Strom's builtin.recorder writes local files only
 * ({media_path}/{output_dir}/{filename_prefix}_{timestamp}_%05d.{ext}, per
 * backend/src/blocks/builtin/recorder.rs — confirmed by the PM on issue #41,
 * 2026-09-15). It has NO native S3/MinIO sink. So after a production
 * deactivates, open-live:
 *
 *   1. lists the recorder's output directory via Strom's media API
 *      (`GET /api/media?path=`), then
 *   2. downloads each segment via Strom's media file API
 *      (`GET /api/media/file/:path`), and
 *   3. streams it to MinIO/S3 signed with AWS Signature V4 — a single PutObject
 *      for small files, S3 multipart upload above 16 MiB (issue #548: the OSC
 *      Silo ingress answers 413 to request bodies over ~64 MiB). The download
 *      is piped into the upload one part at a time (issue #552), so a segment
 *      is never held in memory whole.
 *
 * The S3 PutObject signer here is intentionally dependency-free (node's built-in
 * `crypto`, same as src/lib/srt-passphrase-crypto.ts) so the pinned lockfile
 * stays untouched — no aws-sdk / minio client is pulled in.
 *
 * Delete-after-upload (issue #366): Strom has no retention/TTL for recorder
 * output — confirmed against Strom main, see #366 — so local segments would
 * otherwise accumulate on its media volume forever. Once a segment is
 * successfully uploaded, `uploadRecordings` deletes it from Strom via
 * `DELETE /api/media/file/:path`, then removes the now-empty output directory
 * via `DELETE /api/media/directory/:path` (which only succeeds on an empty
 * directory). Segments that failed to upload are left in place so the next
 * deactivate's sweep retries them. This mirrors the precedent set by Strom's
 * own TAMS output block (delete-after-registration, keep-on-failure).
 *
 * Persisting a RecordingDoc and the listing/playback endpoint are issue #42 and
 * deliberately NOT implemented here.
 */
import { createHash, createHmac } from 'crypto';
import { config } from '../config.js';
import type { StromClient } from './strom.js';
import { Mp4DurationScanner } from './mp4-duration.js';

export interface MinioTarget {
  endpoint: string; // host[:port], no scheme
  useSsl: boolean;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export interface UploadedSegment {
  /** object key written into the bucket */
  key: string;
  sizeBytes: number;
  /**
   * Strom media path the segment was read from (e.g.
   * `recordings/<productionId>/seg_00001.mp4`) — retained so a successfully
   * uploaded segment can be deleted from Strom afterward (issue #366).
   */
  stromPath: string;
  /**
   * When the recording session that wrote the segment began (ISO 8601), read
   * from the timestamp Strom puts in the file name. Undefined when the name
   * carries none.
   */
  startedAt?: string;
  /**
   * Media duration in milliseconds, read from the MP4 movie header (issue
   * #534). Undefined for a non-MP4 file or a header that cannot be read.
   */
  durationMs?: number;
}

export interface UploadResult {
  uploaded: UploadedSegment[];
  /** Segments that failed to download or upload — logged, non-fatal. */
  failed: Array<{ file: string; error: string }>;
  /**
   * Set when the sweep short-circuited on a deterministic object-store
   * auth/permission failure (HTTP 401/403, or an S3 `InvalidAccessKeyId` /
   * `AccessDenied` / `SignatureDoesNotMatch` error code). Such a failure is the
   * same for every object in the bucket, so the sweep stops after the first one
   * rather than re-downloading + re-PUTting (and re-failing) the rest — the
   * whole point is that a rejected store must not make deactivate grind through
   * the backlog. The offending file is also recorded in `failed`.
   */
  abortedOnAuthError?: { file: string; code: string };
}

/**
 * S3 `<Code>` values that signal a deterministic credential/permission
 * rejection — they fail identically for every object in the bucket, so the
 * upload sweep treats the first one as fatal to the whole sweep rather than a
 * per-file transient error (see `uploadRecordings`).
 */
const S3_AUTH_ERROR_CODES = ['InvalidAccessKeyId', 'AccessDenied', 'SignatureDoesNotMatch'];

/**
 * Thrown by `putObject` when the object store rejects the request with a
 * deterministic auth/permission error — an HTTP 401/403, or one of the
 * `S3_AUTH_ERROR_CODES`. `code` is the S3 error code when the body carried one,
 * else the HTTP status as a string.
 */
export class S3AuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'S3AuthError';
    this.code = code;
  }
}

/**
 * Returns the auth/permission error code when an S3/MinIO error response
 * signals a deterministic credential/permission rejection, else null (a
 * transient/other error the sweep should treat as per-file best-effort). An S3
 * error body carries the code as `<Code>…</Code>`; MinIO may also surface it as
 * plain text, so we substring-match the known codes first and fall back to the
 * 401/403 status.
 */
export function detectS3AuthError(status: number, body: string): string | null {
  for (const code of S3_AUTH_ERROR_CODES) {
    if (body.includes(code)) return code;
  }
  if (status === 401 || status === 403) {
    const match = /<Code>([^<]+)<\/Code>/.exec(body);
    return match?.[1] ?? String(status);
  }
  return null;
}

/**
 * Builds a MinioTarget from the service config, or returns null when recording
 * is not fully configured. Callers must treat null as "recording disabled".
 *
 * `bucketOverride` (non-empty) replaces the configured MINIO_BUCKET while the
 * endpoint/credentials still come from config — used by s3 clip references,
 * which carry their own bucket. With an override, MINIO_BUCKET need not be set.
 */
export function minioTargetFromConfig(bucketOverride?: string): MinioTarget | null {
  const bucket = bucketOverride || config.minioBucket;
  if (
    !config.minioEndpoint ||
    !config.minioAccessKey ||
    !config.minioSecretKey ||
    !bucket
  ) {
    return null;
  }
  const { endpoint, useSsl } = normalizeS3Endpoint(config.minioEndpoint, config.minioUseSsl);
  return {
    endpoint,
    useSsl,
    region: config.minioRegion,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
    bucket,
  };
}

/**
 * Normalises an S3/MinIO endpoint — a bare `host[:port]` or a full URL — to a
 * `host[:port]` string plus a `useSsl` flag derived from the scheme when one is
 * present (otherwise `useSslDefault`). Shared by `minioTargetFromConfig()` and
 * the storage-connection resource (issue #520) so both normalise identically.
 */
export function normalizeS3Endpoint(
  raw: string,
  useSslDefault: boolean,
): { endpoint: string; useSsl: boolean } {
  let endpoint = raw;
  let useSsl = useSslDefault;
  const schemeMatch = /^(https?):\/\/(.+)$/i.exec(endpoint);
  if (schemeMatch) {
    useSsl = schemeMatch[1]!.toLowerCase() === 'https';
    endpoint = schemeMatch[2]!;
  }
  endpoint = endpoint.replace(/\/+$/, '');
  return { endpoint, useSsl };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 percent-encoding, as required for SigV4 canonical query values. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Encodes an object key path segment-by-segment for use in an S3 URI. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Sends one SigV4-signed S3 request (path-style addressing — the only form
 * MinIO supports without per-bucket DNS). `query` entries are sorted and
 * RFC 3986-encoded into the canonical query string as SigV4 requires; a
 * valueless sub-resource such as `uploads` is passed as `['uploads', '']`.
 * Does not interpret the response.
 */
async function signedS3Request(
  target: MinioTarget,
  method: 'PUT' | 'POST' | 'DELETE',
  key: string,
  opts: {
    query?: Array<[string, string]>;
    body?: Buffer;
    contentType?: string;
    now?: Date;
  } = {},
): Promise<Response> {
  const body = opts.body ?? Buffer.alloc(0);
  const now = opts.now ?? new Date();
  const scheme = target.useSsl ? 'https' : 'http';
  const host = target.endpoint;
  const canonicalUri = `/${encodeKey(target.bucket)}/${encodeKey(key)}`;
  const canonicalQuery = (opts.query ?? [])
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const url = `${scheme}://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;

  // ISO-8601 basic format required by SigV4: YYYYMMDDTHHMMSSZ.
  // now.toISOString() → "2026-09-15T13:00:00.000Z"; strip separators + millis.
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
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

  const headers: Record<string, string> = {
    Host: host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
  };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;

  return fetch(url, {
    method,
    headers,
    // A view over the Buffer's bytes, not a copy — a part is up to 16 MiB.
    ...(method === 'DELETE' ? {} : { body: new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.length) }),
  });
}

/** Throws S3AuthError / Error for a non-2xx S3 response; no-op on success. */
async function assertS3Ok(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  const message = `S3 ${what} failed: ${res.status} ${text.slice(0, 200)}`;
  const authCode = detectS3AuthError(res.status, text);
  if (authCode) {
    throw new S3AuthError(authCode, message);
  }
  throw new Error(message);
}

/**
 * Uploads a single object to S3/MinIO via a SigV4-signed PutObject.
 * Path-style addressing (bucket in the path) — the only form MinIO supports
 * without per-bucket DNS.
 */
export async function putObject(
  target: MinioTarget,
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
  now: Date = new Date(),
): Promise<void> {
  const res = await signedS3Request(target, 'PUT', key, { body, contentType, now });
  await assertS3Ok(res, `PutObject ${key}`);
}

/**
 * Deletes one object via a SigV4-signed DeleteObject (issue #550). Idempotent:
 * a 2xx (S3 answers 204 even for a missing key) and a 404 `NoSuchKey` both
 * count as done, so a retry after a partial failure succeeds. A 404 for a
 * missing bucket (`NoSuchBucket`) is not treated as done — the target may be
 * misconfigured, and the object may still exist elsewhere. Throws
 * `S3AuthError` when the store rejects the key (401/403 or an auth code), else
 * `Error` for any other failure. Error messages may carry the S3 response
 * body; callers must not echo them to API clients.
 */
export async function deleteObject(target: MinioTarget, key: string, now: Date = new Date()): Promise<void> {
  const res = await signedS3Request(target, 'DELETE', key, { now });
  if (res.status === 404) {
    const text = await res.text().catch(() => '');
    if (!text.includes('NoSuchBucket')) return;
    throw new Error(`S3 DeleteObject ${key} failed: 404 ${text.slice(0, 200)}`);
  }
  await assertS3Ok(res, `DeleteObject ${key}`);
  await res.text().catch(() => undefined);
}

/**
 * Size of each multipart part, and the threshold above which an object is
 * uploaded multipart instead of with a single PutObject (issue #548). The OSC
 * Silo ingress rejects request bodies over ~64 MiB with 413, so parts stay
 * well under that. 16 MiB is also above S3's 5 MiB minimum part size.
 */
export const MULTIPART_PART_SIZE = 16 * 1024 * 1024;

/**
 * Uploads an object via S3 multipart upload: CreateMultipartUpload, one
 * UploadPart per `partSize` slice, then CompleteMultipartUpload. If anything
 * fails after the upload was created, AbortMultipartUpload is attempted
 * (best-effort) so the store does not keep orphaned parts, and the original
 * error is rethrown.
 */
export async function putObjectMultipart(
  target: MinioTarget,
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
  partSize: number = MULTIPART_PART_SIZE,
): Promise<void> {
  async function* slices(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < body.length; offset += partSize) {
      yield body.subarray(offset, Math.min(offset + partSize, body.length));
    }
  }
  return multipartUpload(target, key, slices(), contentType);
}

/**
 * The multipart upload itself, fed one part at a time by `parts` (issue #552):
 * the next part is only pulled once the previous UploadPart has completed, so
 * a streamed source never has more than one part in flight. An error thrown
 * while producing a part (e.g. the Strom download dying mid-stream) aborts the
 * upload exactly like a failed UploadPart.
 */
async function multipartUpload(
  target: MinioTarget,
  key: string,
  parts: AsyncIterable<Buffer>,
  contentType: string,
): Promise<void> {
  const createRes = await signedS3Request(target, 'POST', key, {
    query: [['uploads', '']],
    contentType,
  });
  await assertS3Ok(createRes, `CreateMultipartUpload ${key}`);
  const createXml = await createRes.text();
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(createXml)?.[1];
  if (!uploadId) {
    throw new Error(`S3 CreateMultipartUpload ${key} returned no UploadId`);
  }

  try {
    const etags: string[] = [];
    for await (const part of parts) {
      const partNumber = etags.length + 1;
      const res = await signedS3Request(target, 'PUT', key, {
        query: [
          ['partNumber', String(partNumber)],
          ['uploadId', uploadId],
        ],
        body: part,
      });
      await assertS3Ok(res, `UploadPart ${partNumber} of ${key}`);
      const etag = res.headers.get('etag');
      if (!etag) {
        throw new Error(`S3 UploadPart ${partNumber} of ${key} returned no ETag`);
      }
      etags.push(etag);
    }

    const xml =
      '<CompleteMultipartUpload>' +
      etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`)
        .join('') +
      '</CompleteMultipartUpload>';
    const completeRes = await signedS3Request(target, 'POST', key, {
      query: [['uploadId', uploadId]],
      body: Buffer.from(xml, 'utf8'),
      contentType: 'application/xml',
    });
    await assertS3Ok(completeRes, `CompleteMultipartUpload ${key}`);
    // S3 can answer 200 with an <Error> body when completion fails midway.
    const completeText = await completeRes.text().catch(() => '');
    if (/<Error>/.test(completeText)) {
      throw new Error(`S3 CompleteMultipartUpload ${key} failed: ${completeText.slice(0, 200)}`);
    }
  } catch (err) {
    await signedS3Request(target, 'DELETE', key, { query: [['uploadId', uploadId]] })
      .then((r) => r.text().catch(() => undefined))
      .catch(() => undefined);
    throw err;
  }
}

/**
 * Uploads `body` with a single PutObject when it fits in one part, else via
 * multipart upload (issue #548).
 */
export async function uploadObject(
  target: MinioTarget,
  key: string,
  body: Buffer,
  contentType = 'application/octet-stream',
  partSize: number = MULTIPART_PART_SIZE,
): Promise<void> {
  if (body.length <= partSize) {
    return putObject(target, key, body, contentType);
  }
  return putObjectMultipart(target, key, body, contentType, partSize);
}

/**
 * Pull-based reader over a chunk stream that hands out fixed-size parts. Holds
 * at most the part being assembled plus the unread remainder of one source
 * chunk (the read-ahead), and only pulls from the source when asked.
 */
class PartReader {
  private pending: Uint8Array | undefined;
  private ended = false;

  constructor(private readonly source: AsyncIterator<Uint8Array>) {}

  private async pull(): Promise<Uint8Array | undefined> {
    if (this.pending) {
      const chunk = this.pending;
      this.pending = undefined;
      return chunk;
    }
    while (!this.ended) {
      const r = await this.source.next();
      if (r.done) {
        this.ended = true;
        break;
      }
      if (r.value.length > 0) return r.value;
    }
    return undefined;
  }

  /** Reads exactly `n` bytes, or fewer only at end of stream. */
  async read(n: number): Promise<Buffer> {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = await this.pull();
      if (!chunk) break;
      const take = Math.min(n - filled, chunk.length);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take < chunk.length) this.pending = chunk.subarray(take);
    }
    return out.subarray(0, filled);
  }

  /** True once the source is exhausted (peeks one chunk ahead if needed). */
  async atEnd(): Promise<boolean> {
    if (this.pending) return false;
    const chunk = await this.pull();
    if (!chunk) return true;
    this.pending = chunk;
    return false;
  }
}

/**
 * Streams an object of unknown length to S3/MinIO (issue #552): buffers up to
 * one part; if the source ends within it, a single PutObject, otherwise a
 * multipart upload that reads and sends one `partSize` part at a time. At most
 * one part plus one source chunk of read-ahead is held in memory. Returns the
 * number of bytes uploaded. The source iterator is always closed (on success
 * or failure), so an abandoned HTTP download is released.
 */
export async function uploadStream(
  target: MinioTarget,
  key: string,
  source: AsyncIterable<Uint8Array>,
  contentType = 'application/octet-stream',
  partSize: number = MULTIPART_PART_SIZE,
): Promise<number> {
  const iterator = source[Symbol.asyncIterator]();
  const reader = new PartReader(iterator);
  try {
    let first: Buffer | undefined = await reader.read(partSize);
    if (await reader.atEnd()) {
      await putObject(target, key, first, contentType);
      return first.length;
    }
    let total = 0;
    async function* parts(): AsyncGenerator<Buffer> {
      let part: Buffer | undefined = first!;
      first = undefined; // the generator now owns the only reference
      while (part.length > 0) {
        total += part.length;
        yield part;
        part = undefined; // drop the reference before reading the next part
        part = await reader.read(partSize);
      }
    }
    await multipartUpload(target, key, parts(), contentType);
    return total;
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
}

/**
 * Builds a presigned GET URL for an object, so a private bucket's recordings can
 * be played back without exposing the MinIO credentials (spec §API Design:
 * `playbackUrl` is a time-boxed presigned GET). Uses the same dependency-free
 * SigV4 signer (node `crypto`) as `putObject` — query-string signing
 * (`X-Amz-*` params) rather than an Authorization header, path-style addressing.
 */
export function presignGetUrl(
  target: MinioTarget,
  key: string,
  expiresInSeconds: number,
  now: Date = new Date(),
  opts: { contentDisposition?: string } = {},
): string {
  const scheme = target.useSsl ? 'https' : 'http';
  const host = target.endpoint;
  const canonicalUri = `/${encodeKey(target.bucket)}/${encodeKey(key)}`;

  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${target.region}/s3/aws4_request`;
  const signedHeaders = 'host';

  // SigV4 requires the query params to be sorted; build them in canonical order.
  const query =
    `X-Amz-Algorithm=${algorithm}` +
    `&X-Amz-Credential=${encodeURIComponent(`${target.accessKey}/${credentialScope}`)}` +
    `&X-Amz-Date=${amzDate}` +
    `&X-Amz-Expires=${expiresInSeconds}` +
    `&X-Amz-SignedHeaders=${signedHeaders}` +
    // S3 response-header override, signed like every other query param. It
    // sorts after the X-Amz-* params (lowercase after uppercase in byte order),
    // so appending keeps the canonical query sorted (issue #534).
    (opts.contentDisposition !== undefined
      ? `&response-content-disposition=${rfc3986(opts.contentDisposition)}`
      : '');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    query,
    `host:${host}\n`,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
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

  return `${scheme}://${host}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

function contentTypeForFile(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'ts':
      return 'video/mp2t';
    case 'mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Opens a download of a single recorded file from Strom's media API and returns
 * its body as a chunk stream (issue #552 — never buffered whole). Uses the same
 * bearer token the StromClient holds. The StromClient.request() helper rejects
 * non-JSON bodies, so this fetches the binary directly against the same
 * `GET /api/media/file/:path` URL the client declares. Strom serves the file
 * without Range support, so it is read once, front to back.
 */
async function downloadFromStrom(
  stromUrl: string,
  token: string | undefined,
  filePath: string,
): Promise<AsyncGenerator<Uint8Array>> {
  const base = stromUrl.replace(/\/$/, '');
  const url = `${base}/api/media/file/${encodeURIComponent(filePath)}`;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Strom media download ${filePath} failed: ${res.status}`);
  }
  return responseChunks(res);
}

/**
 * Yields a fetch response body chunk by chunk. Closing the generator early
 * (e.g. after a failed upload) cancels the body so the connection is released.
 * A response with no body stream (an empty response) is read as a whole.
 */
async function* responseChunks(res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 0) yield new Uint8Array(buf);
    return;
  }
  const reader = res.body.getReader();
  let done = false;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Start of the recording session that wrote a segment, read from its file name.
 *
 * Strom's recorder names segments `{filename_prefix}_{YYYYmmdd_HHMMSS}_%05d.{ext}`
 * (backend/src/blocks/builtin/recorder.rs), stamping the time the recorder
 * block was built, so every segment of one session carries the same stamp.
 * Strom formats it in the host's local time zone and the name records no
 * offset; it is read as UTC, the zone Strom's container image runs in.
 * Returns undefined when the name has no valid stamp.
 */
export function recordingStartFromFileName(name: string): string | undefined {
  const m = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d+\.[^.]+$/.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, sec] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Reject out-of-range fields (e.g. month 13) that Date.UTC would roll over.
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getUTCHours() !== h
    || date.getUTCMinutes() !== mi || date.getUTCSeconds() !== sec) return undefined;
  return date.toISOString();
}

/** Passes every chunk of `source` through, calling `fn` on each first. */
async function* tap(
  source: AsyncIterable<Uint8Array>,
  fn: (chunk: Uint8Array) => void,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    fn(chunk);
    yield chunk;
  }
}

export interface UploadRecordingsArgs {
  strom: StromClient;
  /** Base URL of the Strom instance (for the raw media download). */
  stromUrl: string;
  /** Bearer token the StromClient was constructed with, for the raw download. */
  stromToken: string | undefined;
  /** The recorder block's output_dir (relative media path) from activation. */
  outputDir: string;
  productionId: string;
  target: MinioTarget;
  /**
   * Checked once, immediately before the delete-after-upload pass (issue
   * #366). Must resolve `true` when the production this `outputDir` belongs
   * to has (or may have) a live/recording activation right now — e.g. it was
   * reactivated while this upload sweep was still in flight. A `true` result
   * leaves every segment (uploaded or not) and the output directory in place:
   * deleting out from under a running recorder risks removing segments it
   * still needs, or racing its own writes into the same directory. Required
   * (not optional/defaulted) so a caller cannot silently skip the guard.
   */
  isStillRecording: () => Promise<boolean> | boolean;
}

/**
 * Uploads every recorded segment under `outputDir` to MinIO/S3, then deletes
 * each successfully uploaded segment from Strom and removes the output
 * directory once it is empty (issue #366).
 *
 * Object keys are `${RECORDING_KEY_PREFIX}${productionId}/${fileName}` so #42's
 * listing endpoint can reconcile by prefix. Per-file upload failures are
 * collected and returned rather than aborting the whole upload — a partial VOD
 * is better than none, and deactivate must not fail because one segment
 * errored. Failed segments are also never deleted, so the next deactivate's
 * sweep retries them.
 */
export async function uploadRecordings(args: UploadRecordingsArgs): Promise<UploadResult> {
  const { strom, stromUrl, stromToken, outputDir, productionId, target, isStillRecording } = args;
  const result: UploadResult = { uploaded: [], failed: [] };

  const listing = await strom.media.list(outputDir);
  const files = (listing.entries ?? []).filter((e) => !e.is_dir);

  const prefix = config.recordingKeyPrefix
    ? `${config.recordingKeyPrefix.replace(/\/+$/, '')}/`
    : '';

  for (const entry of files) {
    try {
      const download = await downloadFromStrom(stromUrl, stromToken, entry.path);
      const key = `${prefix}${productionId}/${entry.name}`;
      const contentType = contentTypeForFile(entry.name);
      // Duration is read from the moov box as the bytes stream past (issue
      // #552); the file itself is never held whole.
      const scanner = contentType === 'video/mp4' ? new Mp4DurationScanner() : undefined;
      const sizeBytes = await uploadStream(target, key, tap(download, (c) => scanner?.push(c)), contentType);
      const startedAt = recordingStartFromFileName(entry.name);
      const durationMs = scanner?.finish();
      result.uploaded.push({
        key,
        sizeBytes,
        stromPath: entry.path,
        ...(startedAt ? { startedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    } catch (err) {
      result.failed.push({
        file: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
      // A credential/permission rejection is deterministic across the whole
      // bucket — every remaining segment would fail identically, each only
      // after a full (wasted) download from Strom. Stop the sweep now so a
      // rejected store cannot keep deactivate running for the length of the
      // backlog; the caller logs the abort and teardown still proceeds.
      if (err instanceof S3AuthError) {
        result.abortedOnAuthError = { file: entry.path, code: err.code };
        break;
      }
    }
  }

  if (await isStillRecording()) {
    return result;
  }

  // Delete only the segments that made it safely into object storage — a
  // failed upload's local copy is the only remaining copy, so it must survive
  // for the next sweep's retry (result.failed already drives that contract).
  let allDeleted = result.failed.length === 0;
  for (const seg of result.uploaded) {
    try {
      await strom.media.deleteFile(seg.stromPath);
    } catch {
      // Best-effort — the object is already safely in MinIO, so a stale local
      // copy is a disk-cleanliness problem, not data loss. Leave it (and skip
      // the directory cleanup below) for the next sweep to retry.
      allDeleted = false;
    }
  }

  // deleteDirectory only succeeds on an empty directory — only attempt it once
  // every listed file was both uploaded and deleted; otherwise leave the
  // (non-empty) folder for the next deactivate to retry.
  if (allDeleted) {
    await strom.media.deleteDirectory(outputDir).catch(() => undefined);
  }

  return result;
}
