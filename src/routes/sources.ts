import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSourcesDb } from '../db/index.js';
import type { SourceDoc } from '../db/types.js';

const SourceInput = z.object({
  name: z.string().min(1),
  address: z.string(),
  streamType: z.enum(['srt', 'whip']),
  status: z.enum(['active', 'inactive']).default('inactive'),
  liveCamera: z.boolean().optional(),
});

const SourcePatch = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  streamType: z.enum(['srt', 'whip']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  liveCamera: z.boolean().optional(),
});

function toApi(doc: SourceDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const sourcesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all sources
  fastify.get('/api/v1/sources', async (_req, reply) => {
    const db = getSourcesDb();
    const result = await db.find({ selector: { type: 'source' } });
    return reply.send(result.docs.map(toApi));
  });

  // Create a source
  fastify.post('/api/v1/sources', async (req, reply) => {
    const body = SourceInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: SourceDoc = {
      _id: `src-${randomUUID()}`,
      type: 'source',
      name: body.name,
      address: body.address,
      streamType: body.streamType,
      status: body.status,
      liveCamera: body.liveCamera,
      createdAt: now,
      updatedAt: now,
    };
    await getSourcesDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  // Get a source
  fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Update a source
  fastify.patch<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    const body = SourcePatch.parse(req.body);
    try {
      const doc = await getSourcesDb().get(req.params.id);
      const updated: SourceDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getSourcesDb().insert(updated);
      return reply.send(toApi(updated));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Delete a source
  fastify.delete<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);
      await getSourcesDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });
};

export default sourcesRoutes;
