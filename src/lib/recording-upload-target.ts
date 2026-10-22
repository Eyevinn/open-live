import { isRecordingEnabled } from '../config.js';
import type { RecordingUploadReason } from '../db/types.js';
import type { MinioTarget } from './recording-uploader.js';
import { DEFAULT_CONNECTION_ID, resolveStorageTarget, StorageConnectionNotFoundError } from './storage-connection.js';

/**
 * Where a production's recording is uploaded, from the recording output's
 * storage connection (absent or "default" = the `MINIO_*` env). Shared by the
 * deactivate sweep and the live part upload (issue #556) so both resolve the
 * same target and refuse for the same reasons.
 */
export type RecordingUploadTarget =
  | { target: MinioTarget }
  | { reason: RecordingUploadReason; message: string; err?: unknown };

export async function resolveRecordingUploadTarget(connectionId: string | undefined): Promise<RecordingUploadTarget> {
  const namedConnection = !!connectionId && connectionId !== DEFAULT_CONNECTION_ID;
  if (!namedConnection && !isRecordingEnabled()) {
    return {
      reason: 'no-storage-target',
      message: 'No storage connection is set on the recording output and MINIO_* object storage is not configured.',
    };
  }
  let target: MinioTarget | null;
  try {
    target = await resolveStorageTarget(connectionId);
  } catch (err) {
    if (err instanceof StorageConnectionNotFoundError) {
      return { reason: 'connection-not-found', message: `Storage connection "${connectionId}" was not found.` };
    }
    return { reason: 'upload-error', message: 'The storage target could not be resolved.', err };
  }
  if (!target) {
    return namedConnection
      ? { reason: 'connection-no-bucket', message: `Storage connection "${connectionId}" has no default bucket.` }
      : { reason: 'no-storage-target', message: 'MINIO_* object storage is not configured.' };
  }
  return { target };
}
