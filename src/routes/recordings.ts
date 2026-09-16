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
import { minioTargetFromConfig, presignGetUrl } from '../lib/recording-uploader.js';

/**
 * Maps a stored RecordingDoc to the public API shape: `_id` → `id`, drops the
 * CouchDB envelope, and attaches a presigned `playbackUrl`. The presign is
 * derived on read (never persisted) so the URL is always freshly time-boxed.
 * When presigning is not possible (storage misconfigured) `playbackUrl` is
 * omitted rather than emitting a broken URL.
 */
function toApi(
  doc: RecordingDoc,
  presign: (bucketKey: { bucket: string; key: string }) => string | undefined,
) {
  const { _id, _rev, type, ...rest } = doc;
  const api: Record<string, unknown> = { id: _id, ...rest };
  const url = presign({ bucket: doc.bucket, key: doc.key });
  if (url) api['playbackUrl'] = url;
  return api;
}

/**
 * Builds a presign function bound to the current MinIO config, or null when
 * recording storage is not configured. The returned function only presigns keys
 * whose bucket matches the configured bucket — a recording persisted against a
 * different (since-reconfigured) bucket cannot be presigned with the current
 * credentials, so it is left without a `playbackUrl` rather than mis-signed.
 */
function buildPresigner(
  log: FastifyBaseLogger,
): ((bucketKey: { bucket: string; key: string }) => string | undefined) | null {
  const target = minioTargetFromConfig();
  if (!target) return null;
  return ({ bucket, key }) => {
    if (bucket !== target.bucket) return undefined;
    try {
      return presignGetUrl(target, key, config.recordingPresignTtlS);
    } catch (err) {
      log.warn({ err, key }, 'recordings — presign failed, omitting playbackUrl');
      return undefined;
    }
  };
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
      const presign = buildPresigner(fastify.log);
      if (!presign) {
        return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
      }
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
        (Array.isArray(result?.docs) ? result.docs : []).map((doc) => toApi(doc, presign)),
      );
    },
  );

  // List recordings across all productions.
  fastify.get('/api/v1/recordings', async (_req, reply) => {
    if (!isRecordingEnabled()) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
    const presign = buildPresigner(fastify.log);
    if (!presign) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
    let result: Awaited<ReturnType<ReturnType<typeof getRecordingsDb>['find']>>;
    try {
      result = await getRecordingsDb().find({ selector: { type: 'recording' }, limit: 500 });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/recordings — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.send(
      (Array.isArray(result?.docs) ? result.docs : []).map((doc) => toApi(doc, presign)),
    );
  });

  // Fetch a single recording.
  fastify.get<{ Params: { id: string } }>('/api/v1/recordings/:id', async (req, reply) => {
    if (!isRecordingEnabled()) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
    const presign = buildPresigner(fastify.log);
    if (!presign) {
      return reply.status(503).send({ error: 'Object storage unavailable', statusCode: 503 });
    }
    try {
      const doc = await getRecordingsDb().get(req.params.id);
      return reply.send(toApi(doc, presign));
    } catch {
      return reply.status(404).send({ error: 'Recording not found', statusCode: 404 });
    }
  });
};

export default recordingsRoutes;
