import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

const AudioPatch = z.object({
  property: z.string().min(1),
  value: z.unknown(),
});

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Strom request timed out')), ms),
    ),
  ]);
}

const audioRoutes: FastifyPluginAsync = async (fastify) => {
  // Get audio element properties from Strom
  fastify.get<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.status(409).send({ error: 'Pipeline not active', statusCode: 409 });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        const result = await withTimeout(
          strom.properties.getElement(doc.stromFlowId, req.params.elementId),
          5000,
        );
        return reply.send(result);
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );

  // Update an audio element property in Strom
  fastify.patch<{ Params: { id: string; elementId: string } }>(
    '/api/v1/productions/:id/audio/:elementId',
    async (req, reply) => {
      const body = AudioPatch.parse(req.body);
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.status(409).send({ error: 'Pipeline not active', statusCode: 409 });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        const result = await withTimeout(
          strom.properties.updateElement(doc.stromFlowId, req.params.elementId, {
            property: body.property,
            value: body.value,
          }),
          5000,
        );
        return reply.send(result);
      } catch (err) {
        const e = err as { statusCode?: number };
        if (e?.statusCode === 404) {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        throw err;
      }
    },
  );
};

export default audioRoutes;
