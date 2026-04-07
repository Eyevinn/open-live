import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { ProductionDoc, Source } from '../db/types.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

const SourceInput = z.object({
  name: z.string().min(1),
  type: z.enum(['camera', 'srt', 'ndi', 'test']),
  liveCamera: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const ProductionInput = z.object({
  name: z.string().min(1),
  sources: z.array(SourceInput).optional(),
});

const ProductionPatch = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const SourcePatch = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(['camera', 'srt', 'ndi', 'test']).optional(),
  liveCamera: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const productionsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all productions
  fastify.get('/api/v1/productions', async (_req, reply) => {
    const db = getDb();
    const result = await db.find({ selector: { type: 'production' } });
    return reply.send(result.docs);
  });

  // Create a production
  fastify.post('/api/v1/productions', async (req, reply) => {
    const body = ProductionInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: ProductionDoc = {
      _id: `prod-${randomUUID()}`,
      type: 'production',
      name: body.name,
      status: 'inactive',
      sources: (body.sources ?? []).map((s) => ({
        id: `src-${randomUUID()}`,
        name: s.name,
        type: s.type,
        liveCamera: s.liveCamera,
        config: s.config ?? {},
      })),
      pipeline: { stromConfig: null, status: 'stopped' },
      graphics: [],
      tally: { pgm: null, pvw: null },
      createdAt: now,
      updatedAt: now,
    };
    const response = await getDb().insert(doc);
    return reply.status(201).send({ ...doc, _rev: response.rev });
  });

  // Get a production
  fastify.get<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);
      return reply.send(doc);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Update a production
  fastify.patch<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    const body = ProductionPatch.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const updated: ProductionDoc = {
        ...doc,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.status !== undefined && { status: body.status }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getDb().insert(updated);
      return reply.send({ ...updated, _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Delete a production
  fastify.delete<{ Params: { id: string } }>('/api/v1/productions/:id', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);
      await getDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Activate a production
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/activate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);
      const updated = { ...doc, status: 'active' as const, updatedAt: new Date().toISOString() };
      await getDb().insert(updated);

      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
      const stromVersion = await strom.system.version()
        .then((info) => info.version)
        .catch(() => null);

      return reply.send({ id: updated._id, name: updated.name, status: updated.status, stromVersion });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Deactivate a production
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/deactivate', async (req, reply) => {
    try {
      const doc = await getDb().get(req.params.id);
      const updated = { ...doc, status: 'inactive' as const, updatedAt: new Date().toISOString() };
      await getDb().insert(updated);
      return reply.send({ id: updated._id, name: updated.name, status: updated.status });
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Add a source to a production
  fastify.post<{ Params: { id: string } }>('/api/v1/productions/:id/sources', async (req, reply) => {
    const body = SourceInput.parse(req.body);
    try {
      const doc = await getDb().get(req.params.id);
      const newSource: Source = {
        id: `src-${randomUUID()}`,
        name: body.name,
        type: body.type,
        liveCamera: body.liveCamera,
        config: body.config ?? {},
      };
      const updated: ProductionDoc = {
        ...doc,
        sources: [...doc.sources, newSource],
        updatedAt: new Date().toISOString(),
      };
      await getDb().insert(updated);
      return reply.status(201).send(newSource);
    } catch {
      return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
    }
  });

  // Update a source
  fastify.patch<{ Params: { id: string; sourceId: string } }>(
    '/api/v1/productions/:id/sources/:sourceId',
    async (req, reply) => {
      const body = SourcePatch.parse(req.body);
      try {
        const doc = await getDb().get(req.params.id);
        const idx = doc.sources.findIndex((s) => s.id === req.params.sourceId);
        if (idx === -1) return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          sources: doc.sources.map((s, i) =>
            i === idx ? { ...s, ...body } : s
          ),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.send(updated.sources[idx]);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Delete a source
  fastify.delete<{ Params: { id: string; sourceId: string } }>(
    '/api/v1/productions/:id/sources/:sourceId',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        const exists = doc.sources.some((s) => s.id === req.params.sourceId);
        if (!exists) return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
        const updated: ProductionDoc = {
          ...doc,
          sources: doc.sources.filter((s) => s.id !== req.params.sourceId),
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.status(204).send();
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );
};

export default productionsRoutes;
