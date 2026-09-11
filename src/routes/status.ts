import type { FastifyPluginAsync } from 'fastify';
import { isDbReady, connectDb, isDbConnected } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';
import { getPortLease } from '../services/port-lease.js';

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
    // SRT listener ports this instance may bind on the shared Strom. Gateways
    // use the range to pick ports for the sources they register.
    const lease = getPortLease();
    const srtPortRange = lease.status === 'leased'
      ? { first: lease.lease.first_port, last: lease.lease.last_port }
      : null;
    return reply.send({ stromHost, srtPortRange, srtPortLease: lease.status });
  });

  fastify.post(
    '/api/v1/reconnect',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (_req, reply) => {
    const result: { db: boolean; strom: boolean } = { db: isDbConnected(), strom: false };

    if (!result.db) {
      try {
        await connectDb();
        fastify.log.info('[reconnect] Database connection restored');
        result.db = true;
      } catch (err: any) {
        fastify.log.error('[reconnect] Failed to connect to database: %s', err?.statusCode ?? err?.message ?? 'unknown');
      }
    }

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
