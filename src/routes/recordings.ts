/**
 * VOD listing + playback endpoints (epic #5, issue #42).
 *
 * Recordings are archived to MinIO/S3 on production deactivate (issue #41): each
 * uploaded object gets a `RecordingDoc` persisted in CouchDB. These routes read
 * those docs and attach a `playbackUrl` — a time-boxed presigned GET URL so a
 * private bucket's recordings can be played without exposing MinIO credentials
 * (spec: docs/specs/vod-recording-minio.md §API Design).
 *
 * Routes:
 *   GET /api/v1/productions/:id/recordings   list a production's recordings
 *   GET /api/v1/recordings                    list recordings across productions
 *   GET /api/v1/recordings/:id                fetch a single recording
 *   DELETE /api/v1/recordings/:id             delete the stored object and its entry (#550)
 *
 * The routes work whether or not the `MINIO_*` env store is configured: a
 * recording written to a storage connection (issue #520) is signed against
 * that connection, so a connection-only instance lists and plays its
 * recordings (issue #534). Only a database failure returns 503.
 *
 * Each recording carries `playbackUrl` and `downloadUrl` (the same presigned
 * GET, plus a signed `response-content-disposition: attachment` so a browser
 * saves it under the object's basename). When neither can be signed,
 * `playbackUnavailable` says why instead.
 */
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { getDb, getRecordingsDb } from '../db/index.js';
import type { RecordingDoc } from '../db/types.js';
import { config } from '../config.js';
import {
  deleteObject,
  minioTargetFromConfig,
  presignGetUrl,
  S3AuthError,
  type MinioTarget,
} from '../lib/recording-uploader.js';
import { isDocNotFoundError } from '../lib/db-errors.js';
import { resolveStorageTarget, StorageConnectionNotFoundError } from '../lib/storage-connection.js';

/** Why a recording has no `playbackUrl` / `downloadUrl` (issue #534). */
export type PlaybackUnavailableReason =
  | 'connection-missing'      // its storage connection no longer exists
  | 'connection-no-bucket'    // the connection resolves to no bucket
  | 'storage-not-configured'  // default-connection recording, MINIO_* not configured
  | 'bucket-mismatch'         // default-connection recording in a bucket other than MINIO_BUCKET
  | 'signing-failed';         // anything else went wrong while signing

/**
 * File name a downloaded recording is saved under: the object key's basename,
 * restricted to a header-safe character set, with an `.mp4` extension.
 */
export function downloadFileName(key: string): string {
  const base = key.split('/').pop() || 'recording';
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return /\.mp4$/i.test(safe) ? safe : `${safe.replace(/\.[^.]*$/, '')}.mp4`;
}

/**
 * Maps a stored RecordingDoc to the public API shape: `_id` → `id`, drops the
 * CouchDB envelope, and attaches presigned `playbackUrl` + `downloadUrl` (or a
 * `playbackUnavailable` reason). Presigns are derived on read (never persisted)
 * so the URLs are always freshly time-boxed.
 */
async function toApi(
  doc: RecordingDoc,
  defaultTarget: MinioTarget | null,
  log: FastifyBaseLogger,
): Promise<Record<string, unknown>> {
  const { _id, _rev, type, ...rest } = doc;
  // A doc written before `kind` existed is a program recording (OL-32a, spec
  // §3.4); the startup migration backfills it, this covers the meantime.
  const api: Record<string, unknown> = { id: _id, ...rest, kind: rest.kind ?? 'program' };
  const signed = await presignRecording(doc, defaultTarget, log);
  if ('reason' in signed) {
    api['playbackUnavailable'] = signed.reason;
  } else {
    api['playbackUrl'] = signed.playbackUrl;
    api['downloadUrl'] = signed.downloadUrl;
  }
  return api;
}

/** Why a recording's storage target cannot be resolved (issue #534, #550). */
export type RecordingTargetUnavailableReason = Exclude<PlaybackUnavailableReason, 'signing-failed'>;

/**
 * Resolves the target a recording was written to. Shared by playback signing
 * and DELETE (issue #550) so both refuse with the same reasons.
 *
 * A recording with a `connectionId` (issue #520) resolves to that connection
 * (bucket from the doc). One without (every pre-#520 recording) keeps the
 * default-bucket-matched path: it only resolves when the stored bucket matches
 * the configured one, since a since-reconfigured bucket cannot be reached with
 * the current credentials (unchanged from #42). Any error other than a missing
 * connection is rethrown.
 */
export async function resolveRecordingTarget(
  doc: RecordingDoc,
  defaultTarget: MinioTarget | null,
): Promise<{ target: MinioTarget } | { reason: RecordingTargetUnavailableReason }> {
  if (doc.connectionId) {
    let resolved: MinioTarget | null;
    try {
      resolved = await resolveStorageTarget(doc.connectionId, doc.bucket);
    } catch (err) {
      if (err instanceof StorageConnectionNotFoundError) return { reason: 'connection-missing' };
      throw err;
    }
    if (!resolved) return { reason: 'connection-no-bucket' };
    return { target: resolved };
  }
  if (!defaultTarget) return { reason: 'storage-not-configured' };
  if (doc.bucket !== defaultTarget.bucket) return { reason: 'bucket-mismatch' };
  return { target: defaultTarget };
}

/** Resolves the target a recording was written to and signs both URLs. */
async function presignRecording(
  doc: RecordingDoc,
  defaultTarget: MinioTarget | null,
  log: FastifyBaseLogger,
): Promise<{ playbackUrl: string; downloadUrl: string } | { reason: PlaybackUnavailableReason }> {
  try {
    const resolved = await resolveRecordingTarget(doc, defaultTarget);
    if ('reason' in resolved) return resolved;
    const { target } = resolved;
    const now = new Date();
    const ttl = config.recordingPresignTtlS;
    return {
      playbackUrl: presignGetUrl(target, doc.key, ttl, now),
      downloadUrl: presignGetUrl(target, doc.key, ttl, now, {
        contentDisposition: `attachment; filename="${downloadFileName(doc.key)}"`,
      }),
    };
  } catch (err) {
    log.warn({ err, key: doc.key }, 'recordings — presign failed, omitting playbackUrl');
    return { reason: 'signing-failed' };
  }
}

const recordingsRoutes: FastifyPluginAsync = async (fastify) => {
  // List recordings for a specific production.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/recordings',
    async (req, reply) => {
      // 404 when the production itself does not exist, matching the other
      // production sub-resource routes.
      // Any other lookup failure is the database being unavailable (503).
      try {
        await getDb().get(req.params.id);
      } catch (err) {
        if (isDocNotFoundError(err)) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        fastify.log.warn({ err }, 'GET /api/v1/productions/:id/recordings — production lookup failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      const defaultTarget = minioTargetFromConfig();
      let result: Awaited<ReturnType<ReturnType<typeof getRecordingsDb>['find']>>;
      try {
        result = await getRecordingsDb().find({
          selector: { type: 'recording', productionId: req.params.id },
          limit: 500,
        });
      } catch (err) {
        fastify.log.warn({ err }, 'GET /api/v1/productions/:id/recordings — DB query failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.send(
        await Promise.all(
          (Array.isArray(result?.docs) ? result.docs : []).map((doc) => toApi(doc, defaultTarget, fastify.log)),
        ),
      );
    },
  );

  // List recordings across all productions.
  fastify.get('/api/v1/recordings', async (_req, reply) => {
    const defaultTarget = minioTargetFromConfig();
    let result: Awaited<ReturnType<ReturnType<typeof getRecordingsDb>['find']>>;
    try {
      result = await getRecordingsDb().find({ selector: { type: 'recording' }, limit: 500 });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/recordings — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.send(
      await Promise.all(
        (Array.isArray(result?.docs) ? result.docs : []).map((doc) => toApi(doc, defaultTarget, fastify.log)),
      ),
    );
  });

  // Fetch a single recording.
  fastify.get<{ Params: { id: string } }>('/api/v1/recordings/:id', async (req, reply) => {
    const defaultTarget = minioTargetFromConfig();
    let doc: RecordingDoc;
    try {
      doc = await getRecordingsDb().get(req.params.id);
    } catch (err) {
      // A missing doc (or an id naming another document type) is a 404; any
      // other failure is the database being unavailable.
      if (isDocNotFoundError(err)) return reply.status(404).send({ error: 'Recording not found', statusCode: 404 });
      fastify.log.warn({ err }, 'GET /api/v1/recordings/:id — DB read failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.send(await toApi(doc, defaultTarget, fastify.log));
  });

  // Delete a recording (issue #550): the stored object first, then its
  // RecordingDoc. The object delete is idempotent (a missing key counts as
  // done), so a retry after a database failure succeeds. Every failure leaves
  // the RecordingDoc in place.
  fastify.delete<{ Params: { id: string } }>('/api/v1/recordings/:id', async (req, reply) => {
    let doc: RecordingDoc;
    try {
      doc = await getRecordingsDb().get(req.params.id);
    } catch (err) {
      if (isDocNotFoundError(err)) return reply.status(404).send({ error: 'Recording not found', statusCode: 404 });
      fastify.log.warn({ err }, 'DELETE /api/v1/recordings/:id — DB read failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }

    let resolved: Awaited<ReturnType<typeof resolveRecordingTarget>>;
    try {
      resolved = await resolveRecordingTarget(doc, minioTargetFromConfig());
    } catch (err) {
      fastify.log.warn({ err, id: doc._id }, 'DELETE /api/v1/recordings/:id — storage target resolution failed');
      return reply.status(502).send({
        error: 'Could not reach the recording\'s storage',
        reason: 'storage-failed',
        statusCode: 502,
      });
    }
    if ('reason' in resolved) {
      return reply.status(409).send({
        error: 'The recording\'s storage target cannot be resolved; the recording was not deleted',
        reason: resolved.reason,
        statusCode: 409,
      });
    }
    const { target } = resolved;

    try {
      await deleteObject(target, doc.key);
    } catch (err) {
      // The S3 error text can carry the response body: log it, never echo it.
      if (err instanceof S3AuthError) {
        fastify.log.warn(
          { id: doc._id, bucket: target.bucket, key: doc.key, code: err.code },
          'DELETE /api/v1/recordings/:id — storage denied the delete',
        );
        return reply.status(502).send({
          error: 'The storage rejected the delete for this key',
          reason: 'storage-denied',
          statusCode: 502,
        });
      }
      fastify.log.warn(
        { err, id: doc._id, bucket: target.bucket, key: doc.key },
        'DELETE /api/v1/recordings/:id — object delete failed',
      );
      return reply.status(502).send({
        error: 'The storage failed to delete the recording',
        reason: 'storage-failed',
        statusCode: 502,
      });
    }

    try {
      await getRecordingsDb().destroy(doc._id, doc._rev!);
    } catch (err) {
      fastify.log.warn({ err, id: doc._id }, 'DELETE /api/v1/recordings/:id — DB delete failed after object delete');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }

    fastify.log.info({ id: doc._id, bucket: target.bucket, key: doc.key }, 'recording deleted');
    return reply.status(204).send();
  });
};

export default recordingsRoutes;
