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
 *   3. uploads it to MinIO/S3 with a PutObject signed with AWS Signature V4.
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
import { createHash, createHmac, randomUUID } from 'crypto';
import { config } from '../config.js';
import { StromClientError, type MediaEntry, type StromClient } from './strom.js';
import { INPUT_RECORDING_DIR_RE, inputRecordingFilePrefix, type InputTrack } from './input-recording.js';

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
   * `recordings/<productionId>/<activation>/seg_00001.mp4`) — retained so a
   * successfully uploaded segment can be deleted from Strom afterward (issue #366).
   */
  stromPath: string;
  /** Start of the activation that recorded it, when its directory name carries one (ISO 8601). */
  activationStartedAt?: string;
  /** When Strom last wrote the file (ISO 8601), if Strom reported it. */
  modifiedAt?: string;
  /** The input it records, for a per-input recording; absent for the program. */
  mixerInput?: string;
  /** Which of that input's tracks the file holds. */
  track?: InputTrack;
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

/** Strom media directory holding every recording of a production. */
export function productionRecordingsDir(productionId: string): string {
  return `recordings/${productionId}`;
}

/**
 * Directory name for one activation's recordings: the activation start as
 * YYYYMMDDTHHMMSSZ, then a uuid so two activations never share a directory.
 */
export function activationRecordingsDirName(startedAt: Date = new Date()): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${randomUUID()}`;
}

/** Inverse of activationRecordingsDirName's timestamp, as ISO 8601; undefined if absent. */
function activationStartFromDirName(name: string): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
}

function keyPrefix(): string {
  return config.recordingKeyPrefix
    ? `${config.recordingKeyPrefix.replace(/\/+$/, '')}/`
    : '';
}

/** Object key a recorded file is uploaded to. */
export function recordingObjectKey(productionId: string, fileName: string): string {
  return `${keyPrefix()}${productionId}/${fileName}`;
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
  const { strom, outputDir, isStillRecording } = args;
  const result: UploadResult = { uploaded: [], failed: [] };
  const listing = await strom.media.list(outputDir);
  const files = (listing.entries ?? []).filter((e) => !e.is_directory);
  const done = await uploadFiles(args, files, undefined, async () => false, result);
  await deleteFromStrom(strom, isStillRecording, [{ path: outputDir, fileCount: files.length, done }]);
  return result;
}

export interface UploadProductionRecordingsArgs extends Omit<UploadRecordingsArgs, 'outputDir'> {
  /**
   * Also upload files directly in the production's directory, where a recorder
   * activated before per-activation directories wrote them.
   */
  includeSharedDir: boolean;
  /** Whether an object key has already been uploaded and registered; those files are skipped. */
  isUploaded: (key: string) => Promise<boolean>;
}

/**
 * Uploads every recording of a production that has not been uploaded yet:
 * each activation's directory under productionRecordingsDir(), so a session
 * whose upload failed at its own deactivate is picked up by a later one.
 * A production that never recorded (no directory on Strom) uploads nothing.
 *
 * Inside an activation's directory, files are the program recording and
 * `video_in_N/` subdirectories hold per-input recordings.
 *
 * Then deletes from Strom every swept file that is in object storage,
 * including ones skipped as already uploaded, and removes each directory
 * that leaves empty (issue #366).
 */
export async function uploadProductionRecordings(args: UploadProductionRecordingsArgs): Promise<UploadResult> {
  const { strom, productionId, includeSharedDir, isUploaded, isStillRecording } = args;
  const result: UploadResult = { uploaded: [], failed: [] };

  let entries: MediaEntry[];
  try {
    entries = (await strom.media.list(productionRecordingsDir(productionId))).entries ?? [];
  } catch (err) {
    if (err instanceof StromClientError && err.status === 404) return result;
    throw err;
  }

  const swept: SweptDir[] = [];
  for (const dir of entries.filter((e) => e.is_directory)) {
    let listed: MediaEntry[];
    try {
      listed = (await strom.media.list(dir.path)).entries ?? [];
    } catch (err) {
      result.failed.push({ file: dir.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const startedAt = activationStartFromDirName(dir.name);
    // Subdirectories first, so the activation's own directory is only removed
    // once they have been.
    for (const sub of listed.filter((e) => e.is_directory && INPUT_RECORDING_DIR_RE.test(e.name))) {
      let files: MediaEntry[];
      try {
        files = ((await strom.media.list(sub.path)).entries ?? []).filter((e) => !e.is_directory);
      } catch (err) {
        result.failed.push({ file: sub.path, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const done = await uploadFiles(args, files, startedAt, isUploaded, result, sub.name);
      swept.push({ path: sub.path, fileCount: files.length, done });
    }
    const files = listed.filter((e) => !e.is_directory);
    const done = await uploadFiles(args, files, startedAt, isUploaded, result);
    swept.push({ path: dir.path, fileCount: files.length, done });
  }
  if (includeSharedDir) {
    // Listed last so its directory, the production's, is only removed once
    // every activation directory inside it has been.
    const files = entries.filter((e) => !e.is_directory);
    const done = await uploadFiles(args, files, undefined, isUploaded, result);
    swept.push({ path: productionRecordingsDir(productionId), fileCount: files.length, done });
  }
  await deleteFromStrom(strom, isStillRecording, swept);
  return result;
}

/**
 * Uploads `files`, adding each to `result`. Returns the Strom paths that are
 * now in object storage: those uploaded here and those isUploaded() skipped.
 */
async function uploadFiles(
  args: Omit<UploadRecordingsArgs, 'outputDir'>,
  files: MediaEntry[],
  activationStartedAt: string | undefined,
  isUploaded: (key: string) => Promise<boolean>,
  result: UploadResult,
  mixerInput?: string,
): Promise<string[]> {
  const { stromUrl, stromToken, productionId, target } = args;
  const done: string[] = [];
  for (const entry of files) {
    try {
      const key = recordingObjectKey(productionId, entry.name);
      if (await isUploaded(key)) {
        done.push(entry.path);
        continue;
      }
      const bytes = await downloadFromStrom(stromUrl, stromToken, entry.path);
      await putObject(target, key, bytes, contentTypeForFile(entry.name));
      result.uploaded.push({
        key,
        sizeBytes: bytes.length,
        stromPath: entry.path,
        ...(activationStartedAt ? { activationStartedAt } : {}),
        ...(entry.modified ? { modifiedAt: new Date(entry.modified * 1000).toISOString() } : {}),
        ...(mixerInput ? { mixerInput } : {}),
        ...(mixerInput ? trackOf(productionId, mixerInput, entry.name) : {}),
      });
      done.push(entry.path);
    } catch (err) {
      result.failed.push({
        file: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return done;
}

function trackOf(productionId: string, mixerInput: string, fileName: string): { track?: InputTrack } {
  const track = (['video', 'audio'] as const).find((t) => fileName.startsWith(`${inputRecordingFilePrefix(productionId, mixerInput, t)}_`));
  return track ? { track } : {};
}

interface SweptDir {
  path: string;
  /** Files listed in it */
  fileCount: number;
  /** Strom paths of its files that are in object storage */
  done: string[];
}

/**
 * Deletes the swept files that are safely in object storage from Strom, then
 * removes each directory whose listed files were all deleted. Skipped entirely
 * when isStillRecording() resolves true.
 */
async function deleteFromStrom(
  strom: StromClient,
  isStillRecording: () => Promise<boolean> | boolean,
  swept: SweptDir[],
): Promise<void> {
  if (await isStillRecording()) return;

  for (const dir of swept) {
    // Delete only the segments that made it safely into object storage — a
    // failed upload's local copy is the only remaining copy, so it must survive
    // for the next sweep's retry.
    let allDeleted = dir.done.length === dir.fileCount;
    for (const path of dir.done) {
      try {
        await strom.media.deleteFile(path);
      } catch {
        // Best-effort — the object is already safely in MinIO, so a stale local
        // copy is a disk-cleanliness problem, not data loss. The next sweep
        // finds it registered and deletes it then.
        allDeleted = false;
      }
    }
    // deleteDirectory only succeeds on an empty directory — only attempt it once
    // every listed file was both uploaded and deleted.
    if (allDeleted) {
      await strom.media.deleteDirectory(dir.path).catch(() => undefined);
    }
  }
}
