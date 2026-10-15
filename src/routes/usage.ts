/**
 * Shared-GPU usage surfaces (issue #500, `docs/standards/osc-gpu-usage-v1.md`):
 *
 *   - `GET /api/v1/usage/gpu` — closed UTC-hour buckets of shared-GPU seconds per
 *     production (schema `osc-gpu-usage/v1`), for the OSC platform's metering
 *     poller. Guarded automatically by the shared-key `onRequest` gate because it
 *     lives under `/api/v1`; it is deliberately NOT in `AUTH_EXEMPT_PATHS`.
 *   - `GET /metrics` — Prometheus text exposition (`osc_gpu_seconds_total` +
 *     `osc_gpu_active`), for dashboards/alerting. This is a TOP-LEVEL path, so
 *     the auth gate's guarded-prefix check in `src/server.ts` is extended to
 *     include `/metrics` — keeping it out of `AUTH_EXEMPT_PATHS` is necessary but
 *     NOT sufficient (spec §2.1; an unguarded top-level path is served anonymous).
 *
 * Both are bearer-authenticated and read-only. Billing reads the JSON buckets,
 * never the Prometheus counter (ADR-005).
 */

import type { FastifyPluginAsync } from 'fastify';
import { buildGpuUsageResponse, buildPrometheusMetrics, GpuUsageStoreUnavailableError } from '../services/gpu-usage.js';

const usageRoutes: FastifyPluginAsync = async (fastify) => {
  // Closed UTC-hour GPU-second buckets per production (schema osc-gpu-usage/v1).
  fastify.get<{ Querystring: { since?: string } }>('/api/v1/usage/gpu', async (req, reply) => {
    let sinceMs: number | undefined;
    const since = req.query.since;
    if (since !== undefined) {
      const parsed = Date.parse(since);
      if (!Number.isFinite(parsed)) {
        return reply.status(400).send({
          error: 'Invalid "since" — expected an ISO 8601 timestamp (e.g. 2026-10-13T13:00:00Z)',
          statusCode: 400,
        });
      }
      sinceMs = parsed;
    }
    try {
      const body = await buildGpuUsageResponse({ sinceMs }, fastify.log);
      return reply.send(body);
    } catch (err) {
      // Backing store unreachable (osc-gpu-usage-v1 §2): 503, so the platform
      // poller can tell a transient outage from genuine zero usage rather than
      // booking an empty hours array as "no GPU time this hour".
      if (err instanceof GpuUsageStoreUnavailableError) {
        return reply.status(503).send({ error: err.message, statusCode: 503 });
      }
      throw err;
    }
  });

  // Prometheus text exposition. text/plain; version=0.0.4 is the 0.0.4 format.
  fastify.get('/metrics', async (_req, reply) => {
    const text = await buildPrometheusMetrics(fastify.log);
    return reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8').send(text);
  });
};

export default usageRoutes;
