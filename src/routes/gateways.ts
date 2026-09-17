import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getGatewaysDb, getSourcesDb, getDb } from '../db/index.js';
import type { GatewayDoc, SourceDoc, ProductionDoc } from '../db/types.js';
import { generateGatewayToken } from '../lib/gateway-token.js';
import { deriveGatewayHealth, gatewayToApi } from '../lib/gateway-health.js';
import { config } from '../config.js';

const GatewayInput = z.object({
  name: z.string().min(1).max(256),
});

const ForgetQuery = z.object({
  cascadeSources: z.coerce.boolean().default(false),
});

/**
 * OL-5 Studio Gateways Phase 1 — gateway management REST surface (issue #263,
 * `docs/specs/studio-gateways.md` §"API Design").
 *
 * All routes sit behind the existing shared `API_KEY` bearer gate exactly like
 * `/api/v1/sources`. The per-gateway token (ADR-001) is used ONLY on the
 * heartbeat WS upgrade (`src/ws/gateway-heartbeat.ts`), never on these routes.
 */
const gatewaysRoutes: FastifyPluginAsync = async (fastify) => {
  // Register a gateway and mint its per-gateway token (returned exactly once).
  fastify.post('/api/v1/gateways', async (req, reply) => {
    const body = GatewayInput.parse(req.body);
    const { token, tokenHash } = generateGatewayToken();
    const now = new Date().toISOString();
    const doc: GatewayDoc = {
      _id: `gw-${randomUUID()}`,
      type: 'gateway',
      name: body.name,
      tokenHash,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await getGatewaysDb().insert(doc);
    } catch (err) {
      fastify.log.warn({ err }, 'POST /api/v1/gateways — DB write failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    // The raw token is returned here and NEVER again — only its hash is stored.
    return reply.status(201).send({ ...gatewayToApi(doc), token });
  });

  // List all gateways (health recomputed on read).
  fastify.get('/api/v1/gateways', async (_req, reply) => {
    const db = getGatewaysDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'gateway' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/gateways — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    const now = new Date();
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map((d) => gatewayToApi(d, now)));
  });

  // Get one gateway.
  fastify.get<{ Params: { id: string } }>('/api/v1/gateways/:id', async (req, reply) => {
    try {
      const doc = await getGatewaysDb().get(req.params.id);
      return reply.send(gatewayToApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Gateway not found', statusCode: 404 });
    }
  });

  // Rotate the per-gateway token: mint a replacement, invalidate the old one,
  // preserving the gateway id and its source links (ADR-001, OQ-4).
  fastify.post<{ Params: { id: string } }>('/api/v1/gateways/:id/rotate-token', async (req, reply) => {
    let doc: GatewayDoc;
    try {
      doc = await getGatewaysDb().get(req.params.id);
    } catch {
      return reply.status(404).send({ error: 'Gateway not found', statusCode: 404 });
    }
    const { token, tokenHash } = generateGatewayToken();
    const updated: GatewayDoc = { ...doc, tokenHash, updatedAt: new Date().toISOString() };
    try {
      await getGatewaysDb().insert(updated);
    } catch (err) {
      fastify.log.warn({ err }, 'POST /api/v1/gateways/:id/rotate-token — DB write failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }
    return reply.send({ id: updated._id, token });
  });

  // "Forget" a gateway: offline-gated cascade to its sources.
  fastify.delete<{ Params: { id: string } }>('/api/v1/gateways/:id', async (req, reply) => {
    const query = ForgetQuery.parse(req.query);
    let doc: GatewayDoc;
    try {
      doc = await getGatewaysDb().get(req.params.id);
    } catch {
      return reply.status(404).send({ error: 'Gateway not found', statusCode: 404 });
    }

    // Offline gate: never forget a gateway that is still online. `unknown`
    // (never contacted) and `down` (offline past the threshold) are both
    // forgettable; only a fresh heartbeat blocks the forget.
    if (deriveGatewayHealth(doc.lastSeenAt) === 'healthy') {
      return reply.status(409).send({
        error: 'Gateway is still online; cannot forget a live gateway',
        statusCode: 409,
      });
    }
    // Belt-and-braces offline-duration threshold: even a `down` gateway must
    // have been offline for at least GATEWAY_FORGET_MIN_OFFLINE_SECONDS.
    if (doc.lastSeenAt) {
      const offlineSeconds = (Date.now() - Date.parse(doc.lastSeenAt)) / 1000;
      if (offlineSeconds < config.gatewayForgetMinOfflineSeconds) {
        return reply.status(409).send({
          error: 'Gateway has not been offline long enough to forget',
          statusCode: 409,
        });
      }
    }

    // Gather sources this gateway produced. findTrusted: the selector is a
    // literal here and :id is only ever a scalar equality value, never a
    // selector fragment (#257).
    let candidates: SourceDoc[] = [];
    try {
      const found = await getSourcesDb().findTrusted({
        selector: { type: 'source', gatewayId: req.params.id },
        limit: 1000,
      });
      candidates = (Array.isArray(found?.docs) ? found.docs : []) as SourceDoc[];
    } catch (err) {
      fastify.log.warn({ err }, 'DELETE /api/v1/gateways/:id — source lookup failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }

    const deletedSources: string[] = [];
    const keptSources: Array<{ id: string; reason: string }> = [];

    for (const source of candidates) {
      // Reuse the same active-production guard DELETE /api/v1/sources/:id
      // enforces: a source in an active/activating production is never deleted.
      // findTrusted: operators are literals; source._id is a scalar in
      // $elemMatch, never a selector fragment (#257).
      const activeProductions = await getDb().findTrusted({
        selector: {
          type: 'production',
          status: { $in: ['active', 'activating'] },
          sources: { $elemMatch: { sourceId: source._id } },
        },
        fields: ['_id', 'name'],
        limit: 1,
      });

      if (query.cascadeSources && activeProductions.docs.length === 0) {
        // Safe to delete this source outright.
        try {
          await getSourcesDb().destroy(source._id, source._rev!);
          deletedSources.push(source._id);
        } catch (err) {
          fastify.log.warn({ err, sourceId: source._id }, 'forget-gateway cascade: source delete failed');
          keptSources.push({ id: source._id, reason: 'delete failed' });
        }
        continue;
      }

      // Either non-cascade, or the source is in an active production: keep it
      // but unlink it from the (now-forgotten) gateway so it is not orphaned
      // pointing at a dead gateway id.
      const { gatewayId, ...withoutGateway } = source;
      void gatewayId;
      const unlinked: SourceDoc = { ...withoutGateway, updatedAt: new Date().toISOString() };
      try {
        await getSourcesDb().insert(unlinked);
      } catch (err) {
        fastify.log.warn({ err, sourceId: source._id }, 'forget-gateway cascade: source unlink failed');
      }
      if (query.cascadeSources && activeProductions.docs.length > 0) {
        const prod = activeProductions.docs[0] as unknown as Pick<ProductionDoc, 'name'>;
        keptSources.push({ id: source._id, reason: `in active production "${prod.name}"` });
      }
    }

    try {
      await getGatewaysDb().destroy(doc._id, doc._rev!);
    } catch (err) {
      fastify.log.warn({ err }, 'DELETE /api/v1/gateways/:id — gateway delete failed');
      return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
    }

    return reply.send({ id: doc._id, deletedSources, keptSources });
  });
};

export default gatewaysRoutes;
