/**
 * VOD recording uploader — upload-from-local path (epic #5, issue #41).
 *
 * Strom's builtin.recorder writes local files only
 * ({media_path}/{output_dir}/{prefix}_%05d.{ext}, per
 * backend/src/blocks/builtin/recorder.rs — confirmed by the PM on issue #41,
 * 2026-09-15). It has NO native S3/MinIO sink. So after a production
 * deactivates, open-live:
 *
 *   1. lists the recorder's output directory via Strom's media API
 *      (`GET /api/media?path=`), then
 *   2. downloads each segment via Strom's media file API
 *      (`GET /api/media/file/:path`), and
 *   3. uploads it to MinIO/S3 with a PutObject signed with AWS Signature V4.
 *
 * The S3 PutObject signer here is intentionally dependency-free (node's built-in
 * `crypto`, same as src/lib/srt-passphrase-crypto.ts) so the pinned lockfile
 * stays untouched — no aws-sdk / minio client is pulled in.
 *
 * Persisting a RecordingDoc and the listing/playback endpoint are issue #42 and
 * deliberately NOT implemented here.
 */
import { createHash, createHmac } from 'crypto';
import { config } from '../config.js';
import type { StromClient } from './strom.js';

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
}

export interface UploadResult {
  uploaded: UploadedSegment[];
  /** Segments that failed to download or upload — logged, non-fatal. */
  failed: Array<{ file: string; error: string }>;
}

/**
 * Builds a MinioTarget from the service config, or returns null when recording
 * is not fully configured. Callers must treat null as "recording disabled".
 */
export function minioTargetFromConfig(): MinioTarget | null {
  if (
    !config.minioEndpoint ||
    !config.minioAccessKey ||
    !config.minioSecretKey ||
    !config.minioBucket
  ) {
    return null;
  }
  // Accept either a bare host[:port] or a full URL for MINIO_ENDPOINT — normalise
  // to host[:port] + a useSsl flag derived from the scheme when present.
  let endpoint = config.minioEndpoint;
  let useSsl = config.minioUseSsl;
  const schemeMatch = /^(https?):\/\/(.+)$/i.exec(endpoint);
  if (schemeMatch) {
    useSsl = schemeMatch[1]!.toLowerCase() === 'https';
    endpoint = schemeMatch[2]!;
  }
  endpoint = endpoint.replace(/\/+$/, '');
  return {
    endpoint,
    useSsl,
    region: config.minioRegion,
    accessKey: config.minioAccessKey,
    secretKey: config.minioSecretKey,
    bucket: config.minioBucket,
  };
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Encodes an object key path segment-by-segment for use in an S3 URI. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
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
  const scheme = target.useSsl ? 'https' : 'http';
  const host = target.endpoint;
  const canonicalUri = `/${encodeKey(target.bucket)}/${encodeKey(key)}`;
  const url = `${scheme}://${host}${canonicalUri}`;

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
    'PUT',
    canonicalUri,
    '', // no query
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

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      'Content-Type': contentType,
      Authorization: authorization,
    },
    body: new Uint8Array(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`S3 PutObject ${key} failed: ${res.status} ${text.slice(0, 200)}`);
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
    `&X-Amz-SignedHeaders=${signedHeaders}`;

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
 * Downloads a single recorded file from Strom's media API as raw bytes.
 * Uses the same bearer token the StromClient holds. The StromClient.request()
 * helper rejects non-JSON bodies, so this fetches the binary directly against
 * the same `GET /api/media/file/:path` URL the client declares.
 */
async function downloadFromStrom(
  stromUrl: string,
  token: string | undefined,
  filePath: string,
): Promise<Buffer> {
  const base = stromUrl.replace(/\/$/, '');
  const url = `${base}/api/media/file/${encodeURIComponent(filePath)}`;
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Strom media download ${filePath} failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
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
}

/**
 * Uploads every recorded segment under `outputDir` to MinIO/S3.
 *
 * Object keys are `${RECORDING_KEY_PREFIX}${productionId}/${fileName}` so #42's
 * listing endpoint can reconcile by prefix. Per-file failures are collected and
 * returned rather than aborting the whole upload — a partial VOD is better than
 * none, and deactivate must not fail because one segment errored.
 */
export async function uploadRecordings(args: UploadRecordingsArgs): Promise<UploadResult> {
  const { strom, stromUrl, stromToken, outputDir, productionId, target } = args;
  const result: UploadResult = { uploaded: [], failed: [] };

  const listing = await strom.media.list(outputDir);
  const files = (listing.entries ?? []).filter((e) => !e.is_dir);

  const prefix = config.recordingKeyPrefix
    ? `${config.recordingKeyPrefix.replace(/\/+$/, '')}/`
    : '';

  for (const entry of files) {
    try {
      const bytes = await downloadFromStrom(stromUrl, stromToken, entry.path);
      const key = `${prefix}${productionId}/${entry.name}`;
      await putObject(target, key, bytes, contentTypeForFile(entry.name));
      result.uploaded.push({ key, sizeBytes: bytes.length });
    } catch (err) {
      result.failed.push({
        file: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
