import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { exchangeServiceToken, TokenExchangeError } from '../lib/osc-token.js'

/**
 * Auth routes — server-side SAT exchange (issue #204).
 *
 * POST /api/v1/auth/token
 *   Exchanges the server-held OSC PAT for a short-lived Service Access Token
 *   (SAT) and returns ONLY the SAT + its expiry. The PAT is never sent to the
 *   client. This lets browser clients (e.g. open-live-studio, see
 *   open-live-studio#10) obtain a SAT without ever holding the PAT.
 *
 *   The target serviceId is fixed server-side config (config.oscSatServiceId),
 *   never taken from the request body, so this endpoint cannot be turned into
 *   an SSRF / used to mint SATs for an arbitrary service.
 *
 *   Guarded by the global API-key auth hook in server.ts (the path is NOT in
 *   AUTH_EXEMPT_PATHS) and rate-limited below.
 *
 *   STROM_AUTH_MODE is unrelated to this exchange and must NOT gate it (see
 *   issue #329, reverting #324/issue #322's short-circuit): that mode only
 *   controls how *this backend* talks to Strom directly, not what OSC service
 *   the Studio's SAT is scoped to. #322's "403 not entitled" was caused by
 *   config.oscSatServiceId defaulting to eyevinn-strom — a service
 *   funnel-provisioned tenants never subscribe to — not by STROM_AUTH_MODE.
 *   Fixed at the source in #328 (default is now eyevinn-open-live, which every
 *   funnel-provisioned tenant *is* entitled to, direct Strom mode or not).
 *   Short-circuiting here again would make that fix unreachable and leave the
 *   Studio's eyevinn-open-live.sat cookie (see open-live-studio's sat.ts) never
 *   set, so it can't pass the OSC reverse-proxy wall on any funnel instance.
 *   The PAT is never returned in any mode.
 */

// The body carries no security-relevant input: the serviceId and target URL
// are both fixed server-side. We still validate with Zod (repo convention) and
// use .strict() so any unexpected field is a 400 rather than silently ignored.
const TokenRequest = z
  .object({})
  .strict()

const authRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/api/v1/auth/token',
    {
      // Tighter than the global 200/min limit: token minting is low-frequency
      // and each call consumes an upstream PAT exchange.
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        summary: 'Exchange the server-held OSC PAT for a short-lived SAT',
        tags: ['auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              expiry: { type: 'number' },
            },
          },
          502: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
          503: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              statusCode: { type: 'number' },
            },
          },
        },
      },
    },
    async (req, reply) => {
      // Validate the body — throws ZodError (→ 400 via the global handler) on
      // any unexpected field.
      TokenRequest.parse(req.body ?? {})

      if (!config.oscPat) {
        // Misconfiguration: no PAT is available to exchange.
        fastify.log.error(
          'POST /api/v1/auth/token — no OSC PAT configured (set OSC_ACCESS_TOKEN, or legacy OSC_PAT)',
        )
        return reply
          .status(503)
          .send({ error: 'Token exchange is not configured', statusCode: 503 })
      }

      try {
        const sat = await exchangeServiceToken(config.oscPat, config.oscSatServiceId)
        // Return ONLY the short-lived SAT + expiry. Never the PAT.
        return reply.status(200).send({ token: sat.token, expiry: sat.expiry })
      } catch (err) {
        if (err instanceof TokenExchangeError) {
          // Upstream token service unreachable or returned an error → 502.
          // Log the detail server-side; return a generic message to the client.
          fastify.log.error({ err }, 'POST /api/v1/auth/token — SAT exchange failed')
          return reply
            .status(502)
            .send({ error: 'Failed to obtain a service token', statusCode: 502 })
        }
        throw err
      }
    },
  )
}

export default authRoutes
