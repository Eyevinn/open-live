import type { FastifyPluginAsync } from 'fastify';
import { StromClient, StromClientError, type IceServer } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

/**
 * GET /api/v1/ice-servers
 *
 * Proxies strom.system.iceServers() and returns the ICE server list in
 * RTCIceServer shape. The frontend must never call Strom directly — Strom
 * may be behind auth (STROM_TOKEN) and its URL is not exposed to the browser.
 *
 * Response 200: { iceServers: IceServer[] }
 * Response 502: Strom unreachable and no cached config available
 *
 * Stale-on-error with TTL (#90): serve last successful response only while
 * younger than CACHE_TTL_MS. TURN credentials are time-limited; infinite
 * cache is unsafe. Cache-Control: no-store on all responses.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedIceServers: IceServer[] | null = null;
let cacheTimestamp = 0;

function cacheFresh(): boolean {
  return cachedIceServers != null && Date.now() - cacheTimestamp <= CACHE_TTL_MS;
}

const iceServersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/ice-servers', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');

    try {
      const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
      const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });

      const { ice_servers } = await strom.system.iceServers();
      cachedIceServers = ice_servers;
      cacheTimestamp = Date.now();
      return reply.send({ iceServers: ice_servers });
    } catch (err) {
      if (cacheFresh()) {
        fastify.log.warn({ err }, 'Strom unreachable fetching ICE servers — serving TTL-fresh cached response');
        return reply.send({ iceServers: cachedIceServers });
      }
      // Drop expired cache so we do not keep serving stale TURN credentials.
      cachedIceServers = null;
      cacheTimestamp = 0;
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
