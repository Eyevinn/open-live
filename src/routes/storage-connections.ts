/**
 * Storage-connection REST surface (issue #520, OL-21,
 * `docs/specs/storage-connections.md`, ADR-009).
 *
 * All routes sit behind the existing shared `API_KEY` bearer `onRequest` gate
 * (`src/server.ts`), identical to `/api/v1/gateways` and `/api/v1/sources`. A
 * missing/invalid key is rejected with 401 before any handler runs. DB failures
 * return 503, mirroring `gateways.ts`.
 *
 * The secret key is write-only: accepted on create/patch, encrypted immediately
 * (`encv1:` AES-256-GCM, ADR-009 Decision 1), NEVER returned (the view exposes
 * only `secretKeySet: boolean`) and NEVER logged. Operator-supplied endpoints are
 * SSRF-gated by `TRUSTED_STORAGE_HOSTS` (ADR-009 Decision 2). A connection
 * referenced by a source, output, or recording cannot be deleted (§2.6).
 */

import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  getStorageConnectionsDb,
  getSourcesDb,
  getOutputsDb,
  getRecordingsDb,
} from '../db/index.js';
import type { StorageConnectionDoc, SourceDoc, OutputDoc, RecordingDoc } from '../db/types.js';
import { config } from '../config.js';
import { minioTargetFromConfig, normalizeS3Endpoint } from '../lib/recording-uploader.js';
import { storageEndpointHost } from '../lib/url-validation.js';
import { assertS3Bucket } from '../lib/clip-reference.js';
import { encryptStorageSecret } from '../lib/storage-connection-crypto.js';
import {
  resolveStorageTarget,
  listStorageObjects,
  testStorageConnection,
  StorageConnectionNotFoundError,
  StorageListError,
  DEFAULT_CONNECTION_ID,
} from '../lib/storage-connection.js';

const roleEnum = z.enum(['clip', 'recording', 'both']);

const CreateInput = z.object({
  name: z.string().min(1).max(256),
  endpoint: z.string().min(1).max(512),
  region: z.string().max(64).optional(),
  useSsl: z.boolean().optional(),
  accessKey: z.string().min(1).max(256),
  secretKey: z.string().min(1).max(1024),
  defaultBucket: z.string().min(1).max(256).optional(),
  role: roleEnum.optional(),
});

const PatchInput = z.object({
  name: z.string().min(1).max(256).optional(),
  endpoint: z.string().min(1).max(512).optional(),
  region: z.string().max(64).optional(),
  useSsl: z.boolean().optional(),
  accessKey: z.string().min(1).max(256).optional(),
  secretKey: z.string().min(1).max(1024).optional(),
  defaultBucket: z.string().min(1).max(256).optional(),
  role: roleEnum.optional(),
});

const TestInput = z.object({
  bucket: z.string().min(1).max(256).optional(),
  from: z.enum(['open-live', 'strom']).optional(),
});

const ObjectsQuery = z.object({
  prefix: z.string().max(1024).optional(),
  cursor: z.string().max(4096).optional(),
  bucket: z.string().min(1).max(256).optional(),
  maxKeys: z.coerce.number().int().positive().optional(),
});

/** Public resource view — NEVER includes the secret key (spec §2.1). */
function toApi(doc: StorageConnectionDoc): Record<string, unknown> {
  return {
    id: doc._id,
    name: doc.name,
    endpoint: doc.endpoint,
    region: doc.region,
    useSsl: doc.useSsl,
    ...(doc.defaultBucket ? { defaultBucket: doc.defaultBucket } : {}),
    role: doc.role,
    accessKey: doc.accessKey,
    secretKeySet: !!doc.secretKeyEnc,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Synthetic read-only view of the env-derived default connection, or null when
 * no env storage is configured (spec §2.3). Never a stored document; the access
 * key id is not a secret and is surfaced, the secret never is.
 */
function defaultConnectionView(): Record<string, unknown> | null {
  const t = minioTargetFromConfig();
  if (!t) return null;
  return {
    id: DEFAULT_CONNECTION_ID,
    name: 'Default (instance storage)',
    endpoint: t.endpoint,
    region: t.region,
    useSsl: t.useSsl,
    role: 'both',
    accessKey: t.accessKey,
    secretKeySet: true,
    isDefault: true,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * Validates + normalises the create/patch endpoint/bucket semantics. Returns the
 * normalised `{ endpoint, useSsl }` or throws an Error whose message is safe to
 * surface in a 400 (SSRF rejection or bad bucket name).
 */
function validateEndpoint(rawEndpoint: string, useSslHint: boolean | undefined): { endpoint: string; useSsl: boolean } {
  const { endpoint, useSsl } = normalizeS3Endpoint(rawEndpoint, useSslHint ?? true);
  // storageEndpointHost re-does the scheme strip on the raw value and throws on
  // a private/loopback/link-local host not in TRUSTED_STORAGE_HOSTS.
  storageEndpointHost(rawEndpoint, config.trustedStorageHosts);
  return { endpoint, useSsl };
}

const storageConnectionsRoutes: FastifyPluginAsync = async (fastify) => {
  // Create.
  fastify.post('/api/v1/storage-connections', async (req, reply) => {
    const body = CreateInput.parse(req.body);
    let endpoint: string;
    let useSsl: boolean;
    try {
      ({ endpoint, useSsl } = validateEndpoint(body.endpoint, body.useSsl));
      if (body.defaultBucket) assertS3Bucket(body.defaultBucket);
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid storage connection', statusCode: 400 });
    }
    const now = new Date().toISOString();
    const doc: StorageConnectionDoc = {
      _id: `stconn-${randomUUID()}`,
      type: 'storage-connection',
      name: body.name,
      endpoint,
      useSsl,
      region: body.region ?? 'us-east-1',
      accessKey: body.accessKey,
      // Encrypt the secret before it touches CouchDB — never persisted plaintext.
      secretKeyEnc: encryptStorageSecret(body.secretKey),
      ...(body.defaultBucket ? { defaultBucket: body.defaultBucket } : {}),
      role: body.role ?? 'both',
      createdAt: now,
      updatedAt: now,
    };
    try {
      await getStorageConnectionsDb().insert(doc);
    } catch (err) {
      fastify.log.warn({ err }, 'POST /api/v1/storage-connections — DB write failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.status(201).send(toApi(doc));
  });

  // List (includes the synthetic default entry when env storage is configured).
  fastify.get('/api/v1/storage-connections', async (_req, reply) => {
    let result: Awaited<ReturnType<ReturnType<typeof getStorageConnectionsDb>['find']>>;
    try {
      result = await getStorageConnectionsDb().find({ selector: { type: 'storage-connection' }, limit: 500 });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/storage-connections — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    const views = (Array.isArray(result?.docs) ? result.docs : []).map(toApi);
    const def = defaultConnectionView();
    return reply.send(def ? [def, ...views] : views);
  });

  // Read one.
  fastify.get<{ Params: { id: string } }>('/api/v1/storage-connections/:id', async (req, reply) => {
    if (req.params.id === DEFAULT_CONNECTION_ID) {
      const def = defaultConnectionView();
      if (!def) return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
      return reply.send(def);
    }
    try {
      const doc = await getStorageConnectionsDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
    }
  });

  // Update (secret optional — omitted keeps the stored ciphertext).
  fastify.patch<{ Params: { id: string } }>('/api/v1/storage-connections/:id', async (req, reply) => {
    if (req.params.id === DEFAULT_CONNECTION_ID) {
      return reply.status(403).send({ error: 'The default connection is read-only', statusCode: 403 });
    }
    const body = PatchInput.parse(req.body);
    let doc: StorageConnectionDoc;
    try {
      doc = await getStorageConnectionsDb().get(req.params.id);
    } catch {
      return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
    }
    const patch: Partial<StorageConnectionDoc> = {};
    try {
      if (body.endpoint !== undefined) {
        const { endpoint, useSsl } = validateEndpoint(body.endpoint, body.useSsl);
        patch.endpoint = endpoint;
        patch.useSsl = useSsl;
      } else if (body.useSsl !== undefined) {
        patch.useSsl = body.useSsl;
      }
      if (body.defaultBucket !== undefined) {
        assertS3Bucket(body.defaultBucket);
        patch.defaultBucket = body.defaultBucket;
      }
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid storage connection', statusCode: 400 });
    }
    if (body.name !== undefined) patch.name = body.name;
    if (body.region !== undefined) patch.region = body.region;
    if (body.accessKey !== undefined) patch.accessKey = body.accessKey;
    if (body.role !== undefined) patch.role = body.role;
    // Re-encrypt only when a new secret is submitted; otherwise keep the stored
    // ciphertext (the key is never round-tripped through the client).
    if (body.secretKey !== undefined) patch.secretKeyEnc = encryptStorageSecret(body.secretKey);

    const updated: StorageConnectionDoc = { ...doc, ...patch, updatedAt: new Date().toISOString() };
    try {
      await getStorageConnectionsDb().insert(updated);
    } catch (err) {
      fastify.log.warn({ err }, 'PATCH /api/v1/storage-connections/:id — DB write failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.send(toApi(updated));
  });

  // Delete (referential-integrity gated across sources, outputs, recordings).
  fastify.delete<{ Params: { id: string } }>('/api/v1/storage-connections/:id', async (req, reply) => {
    const id = req.params.id;
    if (id === DEFAULT_CONNECTION_ID) {
      return reply.status(403).send({ error: 'The default connection is read-only', statusCode: 403 });
    }
    let doc: StorageConnectionDoc;
    try {
      doc = await getStorageConnectionsDb().get(id);
    } catch {
      return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
    }

    let refs: { sources: number; outputs: number; recordings: number };
    try {
      refs = await countReferences(id);
    } catch (err) {
      fastify.log.warn({ err }, 'DELETE /api/v1/storage-connections/:id — reference lookup failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    const total = refs.sources + refs.outputs + refs.recordings;
    if (total > 0) {
      return reply.status(409).send({
        error: `Storage connection is referenced by ${refs.sources} source(s), ${refs.outputs} output(s), ${refs.recordings} recording(s) and cannot be deleted`,
        statusCode: 409,
        references: refs,
      });
    }

    try {
      await getStorageConnectionsDb().destroy(doc._id, doc._rev!);
    } catch (err) {
      fastify.log.warn({ err }, 'DELETE /api/v1/storage-connections/:id — delete failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.status(204).send();
  });

  // Test connection — structured probe result at HTTP 200 (spec §2.7).
  fastify.post<{ Params: { id: string } }>('/api/v1/storage-connections/:id/test', async (req, reply) => {
    const body = TestInput.parse(req.body ?? {});
    let target;
    try {
      target = await resolveStorageTarget(req.params.id, body.bucket);
    } catch (err) {
      if (err instanceof StorageConnectionNotFoundError) {
        return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
      }
      throw err;
    }
    if (!target) {
      return reply.status(400).send({
        error: 'No bucket to test — provide "bucket" or set the connection defaultBucket',
        statusCode: 400,
      });
    }
    const result = await testStorageConnection(target, { from: body.from });
    return reply.send(result);
  });

  // Read-only object listing for Studio's object picker (spec §2.8).
  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/api/v1/storage-connections/:id/objects',
    async (req, reply) => {
      const query = ObjectsQuery.parse(req.query);
      let target;
      try {
        target = await resolveStorageTarget(req.params.id, query.bucket);
      } catch (err) {
        if (err instanceof StorageConnectionNotFoundError) {
          return reply.status(404).send({ error: 'Storage connection not found', statusCode: 404 });
        }
        throw err;
      }
      if (!target) {
        return reply.status(400).send({
          error: 'No bucket to list — provide "bucket" or set the connection defaultBucket',
          statusCode: 400,
        });
      }
      const maxKeys = Math.min(query.maxKeys ?? config.storageListMaxKeys, config.storageListMaxKeys);
      try {
        const page = await listStorageObjects(target, { prefix: query.prefix ?? '', cursor: query.cursor, maxKeys });
        return reply.send(page);
      } catch (err) {
        if (err instanceof StorageListError) {
          if (err.kind === 'forbidden') return reply.status(403).send({ error: err.message, statusCode: 403 });
          if (err.kind === 'bucket-not-found') return reply.status(404).send({ error: err.message, statusCode: 404 });
          return reply.status(502).send({ error: 'Object store unreachable', statusCode: 502 });
        }
        throw err;
      }
    },
  );
};

/**
 * Counts live references to a connection id across clip `s3` sources (the
 * connectionId lives inside the serialized `SourceDoc.address` JSON, so these are
 * scanned and parsed), `recording` outputs, and recordings. Mirrors the gateway
 * forget-guard shape (§2.6).
 */
async function countReferences(id: string): Promise<{ sources: number; outputs: number; recordings: number }> {
  // Clip sources — connectionId is embedded in the serialized address.
  let sources = 0;
  const srcResult = await getSourcesDb().findTrusted({
    selector: { type: 'source', streamType: 'clip' },
    fields: ['address'],
    limit: 1000,
  });
  for (const s of (Array.isArray(srcResult?.docs) ? srcResult.docs : []) as Array<Pick<SourceDoc, 'address'>>) {
    try {
      const ref = JSON.parse(s.address) as { type?: string; connectionId?: string };
      if (ref.type === 's3' && ref.connectionId === id) sources++;
    } catch {
      // Not a parseable clip reference — ignore.
    }
  }

  // Recording outputs — connectionId is a first-class field. `id` is a scalar
  // value (not a selector operator), so find()'s injection guard permits it.
  const outResult = await getOutputsDb().find({
    selector: { type: 'output', outputType: 'recording', connectionId: id },
    fields: ['_id'],
    limit: 1000,
  });
  const outputs = (Array.isArray(outResult?.docs) ? outResult.docs : []).length;

  const recResult = await getRecordingsDb().find({
    selector: { type: 'recording', connectionId: id },
    fields: ['_id'],
    limit: 1000,
  });
  const recordings = (Array.isArray(recResult?.docs) ? recResult.docs : []).length;

  return { sources, outputs, recordings };
}

export default storageConnectionsRoutes;
