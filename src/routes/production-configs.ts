import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getConfigsDb } from '../db/index.js';
import type { ProductionConfigDoc } from '../db/types.js';

const ConfigInput = z.object({
  name: z.string().min(1).max(256),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])),
});

const ConfigPatch = z.object({
  name: z.string().min(1).max(256).optional(),
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

function toApi(doc: ProductionConfigDoc) {
  const { _rev, type, ...rest } = doc;
  void _rev; void type;
  return rest;
}

const productionConfigsRoutes: FastifyPluginAsync = async (fastify) => {
  // List all configs
  fastify.get('/api/v1/production-configs', async (_req, reply) => {
    const db = getConfigsDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = await db.find({ selector: { type: 'production-config' } as any });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/production-configs — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? (result.docs as unknown as ProductionConfigDoc[]) : []).map(toApi));
  });

  // Create a config
  fastify.post('/api/v1/production-configs', async (req, reply) => {
    const body = ConfigInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: ProductionConfigDoc = {
      _id: `cfg-${randomUUID()}`,
      type: 'production-config',
      name: body.name,
      values: body.values,
      createdAt: now,
      updatedAt: now,
    };
    await getConfigsDb().insert(doc as never);
    return reply.status(201).send(toApi(doc));
  });

  // Update a config (name and/or values)
  fastify.patch<{ Params: { id: string } }>('/api/v1/production-configs/:id', async (req, reply) => {
    const body = ConfigPatch.parse(req.body);
    try {
      const existing = await getConfigsDb().get(req.params.id);
      const doc = existing as unknown as ProductionConfigDoc;
      const updated: ProductionConfigDoc = {
        ...doc,
        ...(body.name !== undefined && { name: body.name }),
        ...(body.values !== undefined && { values: { ...(doc.values ?? {}), ...body.values } }),
        updatedAt: new Date().toISOString(),
      };
      const response = await getConfigsDb().insert(updated as never);
      return reply.send({ ...toApi(updated), _rev: response.rev });
    } catch {
      return reply.status(404).send({ error: 'Config not found', statusCode: 404 });
    }
  });

  // Delete a config
  fastify.delete<{ Params: { id: string } }>('/api/v1/production-configs/:id', async (req, reply) => {
    try {
      const doc = await getConfigsDb().get(req.params.id);
      await getConfigsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Config not found', statusCode: 404 });
    }
  });
};

export default productionConfigsRoutes;
