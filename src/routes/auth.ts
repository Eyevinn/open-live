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
        fastify.log.error('POST /api/v1/auth/token — OSC_PAT is not configured')
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
