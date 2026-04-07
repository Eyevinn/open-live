import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { ProductionDoc } from '../db/types.js';
import { startPipeline, stopPipeline } from '../services/pipeline.service.js';

const ConfigPatch = z.object({
  stromConfig: z.record(z.unknown()),
});

const pipelineRoutes: FastifyPluginAsync = async (fastify) => {
  // Get pipeline config + status
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/pipeline',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        return reply.send(doc.pipeline);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Update Strom JSON config
  fastify.patch<{ Params: { id: string } }>(
    '/api/v1/productions/:id/pipeline/config',
    async (req, reply) => {
      const body = ConfigPatch.parse(req.body);
      try {
        const doc = await getDb().get(req.params.id);
        const updated: ProductionDoc = {
          ...doc,
          pipeline: { ...doc.pipeline, stromConfig: body.stromConfig },
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.send(updated.pipeline);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Start pipeline
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/productions/:id/pipeline/start',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        await startPipeline(req.params.id);
        const updated: ProductionDoc = {
          ...doc,
          pipeline: { ...doc.pipeline, status: 'running' },
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.send(updated.pipeline);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );

  // Stop pipeline
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/productions/:id/pipeline/stop',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        await stopPipeline(req.params.id);
        const updated: ProductionDoc = {
          ...doc,
          pipeline: { ...doc.pipeline, status: 'stopped' },
          updatedAt: new Date().toISOString(),
        };
        await getDb().insert(updated);
        return reply.send(updated.pipeline);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    }
  );
};

export default pipelineRoutes;
