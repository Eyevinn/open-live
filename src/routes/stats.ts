import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { StromClient } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

const statsRoutes: FastifyPluginAsync = async (fastify) => {
  // Get streaming stats for a production (Strom RTP + WebRTC stats passthrough)
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/stats/streaming',
    async (req, reply) => {
      try {
        const doc = await getDb().get(req.params.id);
        if (!doc.stromFlowId) {
          return reply.send({ active: false });
        }
        const stromToken = await getStromToken(config.stromToken).catch(() => undefined);
        const strom = new StromClient({ baseUrl: config.stromUrl, token: stromToken });
        try {
          const [rtpStats, webrtcStats] = await Promise.all([
            strom.flows.rtpStats(doc.stromFlowId),
            strom.flows.webrtcStats(doc.stromFlowId),
          ]);
          return reply.send({ active: true, rtpStats: rtpStats.stats, webrtcStats: webrtcStats.stats });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fastify.log.warn({ err }, 'Failed to fetch streaming stats from Strom');
          return reply.send({ active: true, rtpStats: null, webrtcStats: null, error: message });
        }
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
    },
  );
};

export default statsRoutes;
