import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { timingSafeEqual } from 'crypto';
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
// Routes exempt from API key auth (health probes + status used by the UI before auth is set up).
// /api/v1/reconnect is intentionally NOT exempt (#59): it triggers DB/Strom connection attempts
// and returns their reachability, so an unauthenticated caller could leak infrastructure status
// or exhaust connections. It is a mutating POST and the studio calls it via its authenticated
// api client, so requiring the API key here does not break the legitimate caller.
const AUTH_EXEMPT_PATHS = new Set(['/health', '/ready', '/api/v1/status']);

// Sentinel subprotocols used to carry the API key through the
// Sec-WebSocket-Protocol header on browser WebSocket upgrades (#49). Browsers
// cannot set arbitrary headers on a WS handshake but can offer subprotocols via
// `new WebSocket(url, protocols)`, keeping the key out of the request URL (and
// therefore out of proxy/CDN/DevTools access logs).
//
// The client offers TWO subprotocols:
//   - WS_SUBPROTOCOL_MARKER            ("openlive.bearer") — a plain marker
//   - `${WS_SUBPROTOCOL_KEY_PREFIX}<key>` — carries the actual key
// The server reads the key from the second and echoes back only the plain
// marker, so the secret is never reflected into the handshake *response*
// header (which some proxies also log).
const WS_SUBPROTOCOL_MARKER = 'openlive.bearer';
const WS_SUBPROTOCOL_KEY_PREFIX = 'openlive.bearer.';

/**
 * Extracts the API key from a Sec-WebSocket-Protocol header value, if present.
 * The header is a comma-separated list of client-offered subprotocols; we look
 * for the `openlive.bearer.<key>` sentinel and return the `<key>` portion.
 * Returns undefined when the header is absent or carries no bearer subprotocol.
 */
function extractSubprotocolKey(header: string | string[] | undefined): string | undefined {
  if (!header) return undefined;
  const values = Array.isArray(header) ? header : header.split(',');
  for (const raw of values) {
    const proto = raw.trim();
    if (proto.startsWith(WS_SUBPROTOCOL_KEY_PREFIX)) {
      return proto.slice(WS_SUBPROTOCOL_KEY_PREFIX.length);
    }
  }
  return undefined;
}

// How a request presented its API key, for forensic audit logging (#51). This
// mirrors the two transports the auth hook accepts: the `Authorization: Bearer`
// header (REST / non-browser clients) and the `openlive.bearer.<key>`
// Sec-WebSocket-Protocol subprotocol (browser WS clients, #49). 'none' means no
// credential was presented on the request.
type AuthMethod = 'bearer' | 'ws-subprotocol' | 'none';

/**
 * Masks an API key for audit logging so a suspected-compromise investigation
 * can correlate which key was used WITHOUT ever persisting the secret itself.
 * Only a short suffix survives: `key_***<last4>`. Keys too short to safely
 * reveal a suffix (<8 chars) are fully masked as `key_***`.
 */
function maskCredential(key: string): string {
  if (key.length < 8) return 'key_***';
  return `key_***${key.slice(-4)}`;
}

/**
 * Derives the authentication context for an audit entry from the request
 * headers, truthfully reflecting how THIS server authenticates (#51):
 *   - `Authorization: Bearer <key>`            -> 'bearer'
 *   - `openlive.bearer.<key>` WS subprotocol   -> 'ws-subprotocol'
 *   - neither present                          -> 'none'
 * `maskedCred` is only set when a credential was actually presented, and never
 * contains the raw key — only the `maskCredential` suffix form.
 */
function deriveAuthContext(
  authorization: string | undefined,
  subprotocol: string | string[] | undefined
): { authMethod: AuthMethod; maskedCred?: string } {
  const bearerKey = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (bearerKey) {
    return { authMethod: 'bearer', maskedCred: maskCredential(bearerKey) };
  }
  const subprotocolKey = extractSubprotocolKey(subprotocol);
  if (subprotocolKey) {
    return { authMethod: 'ws-subprotocol', maskedCred: maskCredential(subprotocolKey) };
  }
  return { authMethod: 'none' };
}

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
  //
  // When CORS_ORIGIN is unset we do NOT fall back to a permissive wildcard:
  // an unconfigured deployment must not silently allow cross-origin reads.
  // Instead we disable cross-origin access (origin: false) and warn loudly.
  // An explicit '*' still opts in to wildcard; a comma-separated list is
  // parsed into an allow-list.
  let corsOrigins: boolean | string[];
  if (config.corsOrigin === undefined) {
    fastify.log.warn(
      '[security] CORS_ORIGIN is not set — cross-origin requests are disabled. ' +
      'Set CORS_ORIGIN to your browser client origin (e.g. http://localhost:5173) ' +
      'or a comma-separated list of origins to enable CORS.'
    );
    corsOrigins = false;
  } else if (config.corsOrigin === '*') {
    corsOrigins = true;
  } else {
    corsOrigins = config.corsOrigin.split(',').map((o) => o.trim()).filter(Boolean);
  }
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

  // Rate limiting — 200 requests per minute per IP on API routes; tight per-route limits on activate/WHIP/WHEP
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

  // The browser WebSocket API rejects the handshake unless the server echoes
  // one of the client-offered subprotocols back in Sec-WebSocket-Protocol. When
  // a client authenticates by offering the `openlive.bearer.<key>` subprotocol
  // (#49), we must select it so the connection is not torn down by the browser.
  await fastify.register(websocket, {
    options: {
      handleProtocols: (protocols: Set<string>) => {
        // Select the plain marker when offered so the response header does not
        // reflect the secret-bearing subprotocol. Never echo the key itself.
        if (protocols.has(WS_SUBPROTOCOL_MARKER)) return WS_SUBPROTOCOL_MARKER;
        // No bearer subprotocol offered: don't select any (behaves as before).
        return false;
      },
    },
  });

  // Add basic JSON body parsing (built-in to Fastify)
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e instanceof Error ? e : new Error(String(e)), undefined);
    }
  });

  // Optional API key authentication — enabled when API_KEY env var is set.
  // Exempt: health/ready probes and the read-only status endpoint.
  //
  // How to pass the key:
  //   - REST / non-browser WS clients: `Authorization: Bearer <API_KEY>`.
  //   - Browser WebSocket clients: the JS `WebSocket` API cannot set custom
  //     headers, so the key travels in the `Sec-WebSocket-Protocol` request
  //     header (populated from the `new WebSocket(url, protocols)` subprotocol
  //     list) using the sentinel subprotocol `openlive.bearer.<API_KEY>`.
  //
  // The key is NEVER accepted via the `?key=` query string (#49): reverse
  // proxies, CDNs, and browser DevTools log the full request URL, so a static,
  // non-expiring key placed there leaks into access logs as permanent creds.
  // Both the Authorization header and Sec-WebSocket-Protocol header are already
  // redacted / omitted from request logging.
  if (config.apiKey) {
    // Captured here, outside the closure: TS narrows `config.apiKey` from
    // `string | undefined` to `string` at this `if`, but that narrowing does
    // not carry into the callback passed to addHook below (a new, separate
    // function scope), so `config.apiKey` inside it is still `string | undefined`.
    const apiKey = config.apiKey;
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
      // Browsers can't set the Authorization header on a WebSocket upgrade, but
      // they can set Sec-WebSocket-Protocol via `new WebSocket(url, protocols)`.
      // We carry the key there as the sentinel subprotocol
      // `openlive.bearer.<API_KEY>` instead of the (proxy-logged) ?key= query
      // string. The header is a comma-separated list of offered subprotocols.
      const keyFromSubprotocol = extractSubprotocolKey(req.headers['sec-websocket-protocol']);
      const provided = keyFromHeader ?? keyFromSubprotocol;

      const a = Buffer.from(provided ?? '');
      const b = Buffer.from(apiKey);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.status(401).send({ error: 'Unauthorized', statusCode: 401 });
      }
    });
  }

  // Audit log — structured entry for every mutating API call (POST/PUT/PATCH/DELETE)
  fastify.addHook('onResponse', async (req, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
    if (!req.url.startsWith('/api/v1')) return;
    const ip = req.ip ?? '';
    // Record which credential authenticated the request (#51) so a suspected
    // key compromise can be traced. maskedCred only ever carries a masked
    // suffix — the raw key is never logged.
    const { authMethod, maskedCred } = deriveAuthContext(
      req.headers['authorization'],
      req.headers['sec-websocket-protocol']
    );
    fastify.log.info({
      audit: true,
      method: req.method,
      url: req.url.split('?')[0],
      status: reply.statusCode,
      ip,
      authMethod,
      ...(maskedCred ? { maskedCred } : {}),
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
