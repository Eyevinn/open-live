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
 *
 * When object storage is not configured the endpoints return 503 rather than
 * pretending recordings exist, mirroring how the `recording` output type is
 * rejected at assignment time (issue #41).
 */
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { getDb, getRecordingsDb } from '../db/index.js';
import type { RecordingDoc } from '../db/types.js';
import { config, isRecordingEnabled } from '../config.js';
import { minioTargetFromConfig, presignGetUrl, type MinioTarget } from '../lib/recording-uploader.js';
import { resolveStorageTarget } from '../lib/storage-connection.js';

/**
 * Maps a stored RecordingDoc to the public API shape: `_id` → `id`, drops the
 * CouchDB envelope, and attaches a presigned `playbackUrl`. The presign is
 * derived on read (never persisted) so the URL is always freshly time-boxed.
 *
 * A recording that carries a `connectionId` (issue #520) is presigned against
 * that connection's target (bucket from the doc). One without (every pre-#520
 * recording) keeps the current default-bucket-matched path, so old recordings
 * are unaffected. When presigning is not possible (storage misconfigured, or a
 * since-deleted connection) `playbackUrl` is omitted rather than mis-signed.
 */
async function toApi(
  doc: RecordingDoc,
  defaultTarget: MinioTarget | null,
  log: FastifyBaseLogger,
): Promise<Record<string, unknown>> {
  const { _id, _rev, type, ...rest } = doc;
  const api: Record<string, unknown> = { id: _id, ...rest };
  const url = await presignRecording(doc, defaultTarget, log);
  if (url) api['playbackUrl'] = url;
  return api;
}

async function presignRecording(
  doc: RecordingDoc,
  defaultTarget: MinioTarget | null,
  log: FastifyBaseLogger,
): Promise<string | undefined> {
  try {
    if (doc.connectionId) {
      // Presign against the connection that wrote the asset (bucket from the
      // doc). A since-deleted connection throws → omit playbackUrl, exactly as
      // the default-path bucket mismatch below degrades.
      const target = await resolveStorageTarget(doc.connectionId, doc.bucket);
      if (!target) return undefined;
      return presignGetUrl(target, doc.key, config.recordingPresignTtlS);
    }
    // Default path: only presign when the stored bucket matches the configured
    // one — a recording persisted against a different (since-reconfigured)
    // bucket cannot be signed with the current credentials (unchanged from #42).
    if (!defaultTarget || doc.bucket !== defaultTarget.bucket) return undefined;
    return presignGetUrl(defaultTarget, doc.key, config.recordingPresignTtlS);
  } catch (err) {
    log.warn({ err, key: doc.key }, 'recordings — presign failed, omitting playbackUrl');
    return undefined;
  }
}

const recordingsRoutes: FastifyPluginAsync = async (fastify) => {
  // List recordings for a specific production.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/recordings',
    async (req, reply) => {
      if (!isRecordingEnabled()) {
        return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
      }
      // 404 when the production itself does not exist, matching the other
      // production sub-resource routes.
      try {
        await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
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
    if (!isRecordingEnabled()) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
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
    if (!isRecordingEnabled()) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
    const defaultTarget = minioTargetFromConfig();
    try {
      const doc = await getRecordingsDb().get(req.params.id);
      return reply.send(await toApi(doc, defaultTarget, fastify.log));
    } catch {
      return reply.status(404).send({ error: 'Recording not found', statusCode: 404 });
    }
  });
};

export default recordingsRoutes;
