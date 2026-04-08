import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './config.js';
import healthRoutes from './routes/health.js';
import productionsRoutes from './routes/productions.js';
import sourcesRoutes from './routes/sources.js';
import templatesRoutes from './routes/templates.js';
import pipelineRoutes from './routes/pipeline.js';
import macrosRoutes from './routes/macros.js';
import audioRoutes from './routes/audio.js';
import statsRoutes from './routes/stats.js';
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
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)), undefined);
    }
  });

  // Error handler
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation error', issues: error.issues, statusCode: 400 });
    }
    const statusCode = error.statusCode ?? 500;
    fastify.log.error(error);
    reply.status(statusCode).send({ error: error.message, statusCode });
  });

  await fastify.register(healthRoutes);
  await fastify.register(productionsRoutes);
  await fastify.register(sourcesRoutes);
  await fastify.register(templatesRoutes);
  await fastify.register(pipelineRoutes);
  await fastify.register(macrosRoutes);
  await fastify.register(audioRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(controllerWs);

  return fastify;
}
