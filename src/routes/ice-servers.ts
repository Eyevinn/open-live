import type { FastifyPluginAsync } from 'fastify';
import { StromClient, StromClientError } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

/**
 * GET /api/v1/ice-servers
 *
 * Proxies strom.system.iceServers() and returns the ICE server list in
 * RTCIceServer shape. The frontend must never call Strom directly — Strom
 * may be behind auth (STROM_TOKEN) and its URL is not exposed to the browser.
 *
 * Response 200: { iceServers: RTCIceServer[] }
 * Response 502: Strom unreachable or returned an error
 */
const iceServersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/ice-servers', async (_req, reply) => {
    try {
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

      const { ice_servers } = await strom.system.iceServers();

      // ice_servers from Strom is already compatible with RTCIceServer shape
      // (urls, username?, credential?). Map from snake_case response key to
      // camelCase response expected by the frontend.
      return reply.send({ iceServers: ice_servers });
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
