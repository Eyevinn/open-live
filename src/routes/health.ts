import type { FastifyPluginAsync } from 'fastify';
import { isDbReady } from '../db/index.js';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });

  fastify.get('/ready', async (_req, reply) => {
    const ready = await isDbReady();
    if (!ready) {
      return reply.status(503).send({ error: 'Database not reachable', statusCode: 503 });
    }
    return reply.send({ status: 'ready' });
  });
};

export default healthRoutes;
