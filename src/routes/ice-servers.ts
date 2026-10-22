import type { FastifyPluginAsync } from 'fastify';
import { StromClientError } from '../lib/strom.js';
import { getIceServers } from '../lib/ice-servers.js';

/**
 * GET /api/v1/ice-servers
 *
 * Proxies strom.system.iceServers() and returns the ICE server list in
 * RTCIceServer shape. The frontend must never call Strom directly — Strom
 * may be behind auth (STROM_TOKEN) and its URL is not exposed to the browser.
 * Guests get the same list in their join response (routes/guests.ts).
 *
 * Response 200: { iceServers: IceServer[] }
 * Response 502: Strom unreachable and no cached config available
 *
 * Stale-on-error and cache expiry: see lib/ice-servers.ts.
 */

const iceServersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/ice-servers', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const { iceServers, stale } = await getIceServers();
      if (stale) {
        fastify.log.warn({ err: stale }, 'Strom unreachable fetching ICE servers — serving cached response');
      }
      return reply.send({ iceServers });
    } catch (err) {
      if (err instanceof StromClientError) {
        fastify.log.error({ err }, 'Strom returned an error fetching ICE servers');
        return reply.status(502).send({ error: 'Strom returned an error fetching ICE servers', statusCode: 502 });
      }
      fastify.log.error({ err }, 'Failed to fetch ICE servers from Strom');
      return reply.status(502).send({ error: 'Strom unreachable', statusCode: 502 });
    }
  });
};

export default iceServersRoutes;
