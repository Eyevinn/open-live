import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import healthRoutes from './routes/health.js';
import productionsRoutes from './routes/productions.js';
import pipelineRoutes from './routes/pipeline.js';
import controllerWs from './ws/controller.js';

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
    },
  });

  await fastify.register(cors, {
    origin: config.corsOrigin.split(','),
  });

  await fastify.register(websocket);

  // Add basic JSON body parsing (built-in to Fastify)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)), undefined);
    }
  });

  // Error handler
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const statusCode = error.statusCode ?? 500;
    fastify.log.error(error);
    reply.status(statusCode).send({ error: error.message, statusCode });
  });

  await fastify.register(healthRoutes);
  await fastify.register(productionsRoutes);
  await fastify.register(pipelineRoutes);
  await fastify.register(controllerWs);

  return fastify;
}
