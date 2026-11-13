import type { FastifyPluginAsync } from 'fastify';
import { isDbReady, isDbConnected } from '../db/index.js';
import { connectDbAndInit } from '../lib/post-connect-init.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { getPortReservation } from '../services/port-reservation.js';
import { getStromCapabilities } from '../services/strom-capabilities.js';

const statusRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/ping', async (_req, reply) => {
    return reply.send({ ok: true });
  });

  fastify.get('/api/v1/server-info', async (_req, reply) => {
    let stromHost: string;
    try {
      stromHost = new URL(config.stromUrl).hostname;
    } catch {
      return reply.status(500).send({ error: 'Invalid STROM_URL configured' });
    }
    // SRT listener ports this instance reserved on the shared Strom. Gateways
    // use them to pick ports for the sources they register. An explicit list,
    // not a range: Strom's pool can have holes, so the ports an instance holds
    // are not necessarily contiguous.
    const reservation = getPortReservation();
    const srtPorts = reservation.status === 'reserved' ? reservation.reservation.ports : null;
    // What SRT can do on this Strom, from Strom's GET /api/capabilities
    // (served from cache and refreshed in the background, so this never waits
    // on Strom). Clients offer only the `modes` that are true (#628; reported,
    // never enforced by the API) and offer `srt+relay://auto[@<name>]` only
    // when `relays` is non-empty, with a picker when there is more than one.
    // `state`: `ok` (Strom answered), `unsupported` (older Strom: every mode,
    // no relay), `unreachable` (last known values), `unknown` (not asked yet:
    // every mode, no relay). Relay internal addresses stay Strom's business.
    const caps = await getStromCapabilities();
    const srt = {
      state: caps.state,
      modes: caps.srt.modes,
      relays: caps.srt.relays,
      inboundReachable: caps.inboundReachable,
      ports: caps.ports,
    };
    return reply.send({ stromHost, srtPorts, srtPortState: reservation.status, srt });
  });

  fastify.post(
    '/api/v1/reconnect',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (_req, reply) => {
    const result: { db: boolean; strom: boolean } = { db: isDbConnected(), strom: false };

    // Connect (if needed) AND run the post-connect init (key bootstraps,
    // migrations, …) — connecting alone left the credential-key caches empty
    // so credential writes kept failing with a 503 (issue #581). Idempotent and
    // shares one in-flight run across concurrent calls.
    const wasConnected = result.db;
    try {
      await connectDbAndInit(fastify.log);
      if (!wasConnected) fastify.log.info('[reconnect] Database connection restored');
    } catch (err: any) {
      fastify.log.error('[reconnect] Failed to connect/initialise database: %s', err?.statusCode ?? err?.message ?? 'unknown');
    }
    result.db = isDbConnected();

    try {
      const token = await getStromToken(config.stromToken);
      const client = new StromClient({ baseUrl: config.stromUrl, token: token ?? undefined });
      await client.system.version();
      result.strom = true;
    } catch {
      // Strom still unreachable
    }

    const ok = result.db && result.strom;
    return reply.status(ok ? 200 : 503).send({ ok, ...result });
  },
  );

  fastify.get('/api/v1/status', async (_req, reply) => {
    const [db, strom] = await Promise.all([
      isDbReady(),
      (async () => {
        try {
          const token = await getStromToken(config.stromToken);
          const client = new StromClient({ baseUrl: config.stromUrl, token: token ?? undefined });
          await client.system.version();
          return true;
        } catch {
          return false;
        }
      })(),
    ]);
    return reply.send({ db, strom });
  });
};

export default statusRoutes;
