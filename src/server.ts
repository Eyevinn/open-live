import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { ZodError } from 'zod';
import { config } from './config.js';
import { isDbConnected } from './db/index.js';
import healthRoutes from './routes/health.js';
import statusRoutes from './routes/status.js';
import productionsRoutes from './routes/productions.js';
import sourcesRoutes from './routes/sources.js';
import pipelineRoutes from './routes/pipeline.js';
import macrosRoutes from './routes/macros.js';
import audioRoutes from './routes/audio.js';
import statsRoutes from './routes/stats.js';
import iceServersRoutes from './routes/ice-servers.js';
import whepProxyRoutes from './routes/whep-proxy.js';
import whipRoutes from './routes/whip.js';
import productionConfigsRoutes from './routes/production-configs.js';
import graphicsRoutes from './routes/graphics.js';
import outputsRoutes from './routes/outputs.js';
import controllerWs from './ws/controller.js';

// Routes exempt from the DB-availability guard (don't touch the DB)
const DB_EXEMPT_PATHS = new Set(['/health', '/ready', '/api/v1/status', '/api/v1/server-info', '/api/v1/reconnect']);
// Routes exempt from API key auth (health probes + reconnect/status used by the UI before auth is set up)
const AUTH_EXEMPT_PATHS = new Set(['/health', '/ready', '/api/v1/status', '/api/v1/reconnect']);

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      // Defence-in-depth: strip credentials from any log object regardless of
      // call site, in case a raw flow/source/error escapes explicit redaction.
      // Field names mirror the sensitive keys in src/lib/log-redact.ts.
      redact: {
        paths: [
          'srt_uri',
          'passphrase',
          'streamid',
          'token',
          'secret',
          '*.srt_uri',
          '*.passphrase',
          '*.streamid',
          '*.token',
          '*.secret',
          'req.headers.authorization',
          'headers.authorization',
        ],
        censor: '[REDACTED]',
      },
    },
    disableRequestLogging: true,
    // Prevent memory exhaustion via oversized request bodies (1 MB limit)
    bodyLimit: 1_048_576,
    // Trust the X-Forwarded-For header from the ingress proxy so that req.ip
    // resolves to the real client IP rather than the proxy's address.
    // Without this, the header is treated as user-controlled input, allowing
    // spoofed IPs to bypass rate limiting.
    trustProxy: true,
  });

  // CORS must be registered before Helmet so its onRequest hook runs first
  // and Access-Control-Allow-Origin is set before Helmet's hooks fire.
  const corsOrigins = config.corsOrigin === '*'
    ? true
    : config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  await fastify.register(cors, {
    origin: corsOrigins,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    maxAge: 86400,
    strictPreflight: true,
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], connectSrc: ["'self'"] },
    },
    // same-origin: this is a private JSON API, not a public CDN. cross-origin
    // reads are already selectively permitted via CORS preflight; a global
    // cross-origin CRP would additionally expose responses to no-cors fetches.
    crossOriginResourcePolicy: { policy: 'same-origin' },
    strictTransportSecurity: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  });

  // Rate limiting — 200 requests per minute per IP on API routes
  // Activation and WHIP/WHEP proxy get tighter limits (10/min) to prevent abuse
  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    // Skip health/ready probes — they are high-frequency and come from the cluster
    allowList: (req: { url: string }) => req.url === '/health' || req.url === '/ready',
    skipOnError: false,
    keyGenerator: (req: { ip: string }) => req.ip,
    errorResponseBuilder: (_req, context) => ({
      error: 'Too many requests',
      statusCode: 429,
      retryAfter: context.after,
    }),
  });

  await fastify.register(swagger, {
    openapi: {
      info: { title: 'Open Live API', version: '1.0.0', description: 'REST API for the Open Live broadcast production platform.' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/documentation',
    uiConfig: { docExpansion: 'list', deepLinking: true },
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

  // Optional API key authentication — enabled when API_KEY env var is set.
  // Exempt: health/ready probes and status/reconnect endpoints.
  // WS connections: pass key via Authorization header or ?key= query param on upgrade.
  if (config.apiKey) {
    fastify.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0]!;
      if (AUTH_EXEMPT_PATHS.has(path)) return;
      // Guard the REST API, the WebSocket controller, and the Swagger UI /
      // OpenAPI spec routes. The /ws/ prefix must be listed explicitly:
      // without it, /ws/productions/:id/controller bypasses auth entirely and
      // accepts live production commands unauthenticated. The /documentation
      // prefix must also be listed: Swagger UI and its specs
      // (/documentation, /documentation/json, /documentation/yaml) sit outside
      // /api/v1 and would otherwise expose the full API blueprint — route
      // signatures, schemas, and the bearer-auth config — unauthenticated even
      // when API_KEY is set.
      if (
        !req.url.startsWith('/api/v1') &&
        !req.url.startsWith('/ws/') &&
        !req.url.startsWith('/documentation')
      ) {
        return;
      }

      const authHeader = req.headers['authorization'];
      const keyFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
      // WS upgrade carries key in query string since JS WebSocket API doesn't support custom headers
      const keyFromQuery = (req.query as Record<string, string>)?.['key'];
      const provided = keyFromHeader ?? keyFromQuery;

      if (provided !== config.apiKey) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }
    });
  }

  // Audit log — structured entry for every mutating API call (POST/PUT/PATCH/DELETE)
  fastify.addHook('onResponse', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (!req.url.startsWith('/api/v1')) return;
    const ip = req.ip ?? '';
    fastify.log.info({
      audit: true,
      method: req.method,
      url: req.url.split('?')[0],
      status: reply.statusCode,
      ip,
    }, 'audit');
  });

  // Reject DB-dependent routes when database is unavailable
  fastify.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (!isDbConnected() && req.url.startsWith('/api/v1') && !DB_EXEMPT_PATHS.has(path)) {
      reply.status(503).send({ error: 'Database unavailable — please check your CouchDB is running' });
    }
  });

  // Error handler — never leak internal details (stack traces, DB errors, Strom internals) on 5xx
  fastify.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation error', issues: error.issues, statusCode: 400 });
    }
    const statusCode = error.statusCode ?? 500;
    fastify.log.error(error);
    // For 4xx we expose the message (it's validation/not-found feedback for the caller).
    // For 5xx we return a generic message to avoid leaking internals.
    const clientMessage = statusCode < 500 ? error.message : 'An internal error occurred';
    reply.status(statusCode).send({ error: clientMessage, statusCode });
  });

  await fastify.register(healthRoutes);
  await fastify.register(statusRoutes);
  await fastify.register(productionsRoutes);
  await fastify.register(sourcesRoutes);
  await fastify.register(pipelineRoutes);
  await fastify.register(macrosRoutes);
  await fastify.register(audioRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(iceServersRoutes);
  await fastify.register(whepProxyRoutes);
  await fastify.register(whipRoutes);
  await fastify.register(productionConfigsRoutes);
  await fastify.register(graphicsRoutes);
  await fastify.register(outputsRoutes);
  await fastify.register(controllerWs);

  return fastify;
}
