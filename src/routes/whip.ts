import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { getStromToken } from '../lib/strom-token.js'
import { assertSameStromOrigin } from '../lib/url-validation.js'
import { isUnderEndpointPath } from '../lib/guest-scope.js'
import { config } from '../config.js'

/**
 * Validates that a session URL belongs to the configured Strom host.
 * Prevents SSRF / SAT token exfiltration to an attacker-controlled host.
 */
function validateSessionUrl(sessionUrl: string): void {
  assertSameStromOrigin(sessionUrl, config.stromUrl, 'Session URL');
}

type WhipSessionRequest = FastifyRequest<{
  Params: { id: string; mixerInput: string }
  Querystring: { session?: string }
}>

type TargetResolution =
  | { ok: true; target: string }
  | { ok: false; status: number; body: { error: string; statusCode?: number } }

/**
 * Resolves the Strom WHIP target for a PATCH/DELETE call.
 *
 * `?session=` is client-supplied, and `validateSessionUrl` only checks it is
 * on the Strom host — not that it belongs to THIS caller (issue #380). For a
 * guest caller (`req.guestScope` set by the shared-key gate in server.ts) that
 * is not enough: a guest could otherwise PATCH/DELETE another guest's session
 * by supplying its URL. So for guest callers we additionally require the
 * decoded session URL's path to be the scoped endpoint
 * (`resolveStromWhipUrl(:id, :mixerInput)`) or a sub-path of it — rejecting
 * anything else with 403. Crew/API_KEY callers are unaffected (unchanged
 * behaviour — full access, any mixerInput).
 */
function resolveWhipSessionTarget(req: WhipSessionRequest): TargetResolution {
  if (!req.query.session) {
    return { ok: true, target: resolveStromWhipUrl(req.params.id, req.params.mixerInput) }
  }
  const decoded = decodeURIComponent(req.query.session)
  try {
    validateSessionUrl(decoded)
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: { error: err instanceof Error ? err.message : 'Invalid session URL' },
    }
  }
  if (req.guestScope) {
    const expectedEndpoint = resolveStromWhipUrl(req.params.id, req.params.mixerInput)
    if (!isUnderEndpointPath(decoded, expectedEndpoint)) {
      return {
        ok: false,
        status: 403,
        body: { error: 'Session does not belong to this guest', statusCode: 403 },
      }
    }
  }
  return { ok: true, target: decoded }
}

/**
 * WHIP signaling proxy — forwards SDP offer/answer, ICE trickle, and teardown
 * to Strom while keeping the Strom URL internal.
 *
 * POST   /api/v1/productions/:id/whip/:mixerInput
 *   Body: SDP offer (application/sdp)
 *   Returns: SDP answer + Location header pointing back through this proxy
 *
 * PATCH  /api/v1/productions/:id/whip/:mixerInput?session=<encoded>
 *   Body: ICE fragment (application/trickle-ice-sdpfrag)
 *
 * DELETE /api/v1/productions/:id/whip/:mixerInput?session=<encoded>
 *   Tears down the WHIP session on Strom
 */

/** Derives the Strom WHIP endpoint URL for a given production + mixerInput. */
export function resolveStromWhipUrl(productionId: string, mixerInput: string): string {
  const padMatch = /video_in_(\d+)$/.exec(mixerInput)
  const padIndex = padMatch ? parseInt(padMatch[1], 10) : 0
  const endpointSuffix = productionId.replace(/^prod-/, '').slice(0, 8)
  return `${config.stromUrl}/whip/whip-${padIndex}-${endpointSuffix}`
}

const whipRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })
  fastify.addContentTypeParser('application/trickle-ice-sdpfrag', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  // POST — initial WHIP offer/answer
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id: productionId, mixerInput } = req.params
      const stromTarget = resolveStromWhipUrl(productionId, mixerInput)

      const token = await getStromToken(config.stromToken).catch(() => undefined)
      const headers: Record<string, string> = { 'Content-Type': 'application/sdp' }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const upstream = await fetch(stromTarget, {
        method: 'POST',
        headers,
        body: req.body as string,
      })

      if (!upstream.ok) {
        return reply.status(upstream.status).send(await upstream.text())
      }

      const answerSdp = await upstream.text()

      // Rewrite Location so subsequent ICE/teardown requests come back through us.
      const stromLocation = upstream.headers.get('Location')
      if (stromLocation) {
        const absoluteStromLocation = stromLocation.startsWith('http')
          ? stromLocation
          : `${new URL(stromTarget).origin}${stromLocation}`
        const proxyLocation =
          `/api/v1/productions/${productionId}/whip/${encodeURIComponent(mixerInput)}` +
          `?session=${encodeURIComponent(absoluteStromLocation)}`
        reply.header('Location', proxyLocation)
      }

      reply.header('Content-Type', 'application/sdp')
      return reply.status(201).send(answerSdp)
    },
  )

  // PATCH — ICE trickle update
  fastify.patch<{
    Params: { id: string; mixerInput: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    async (req, reply) => {
      const resolved = resolveWhipSessionTarget(req)
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      const target = resolved.target

      const token = await getStromToken(config.stromToken).catch(() => undefined)
      const headers: Record<string, string> = {
        'Content-Type': 'application/trickle-ice-sdpfrag',
      }
      if (token) headers['Authorization'] = `Bearer ${token}`

      const upstream = await fetch(target, { method: 'PATCH', headers, body: req.body as string })
      return reply.status(upstream.status).send()
    },
  )

  // DELETE — teardown
  fastify.delete<{
    Params: { id: string; mixerInput: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    async (req, reply) => {
      const resolved = resolveWhipSessionTarget(req)
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      const target = resolved.target

      const token = await getStromToken(config.stromToken).catch(() => undefined)
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      await fetch(target, { method: 'DELETE', headers }).catch(() => { /* ignore teardown errors */ })
      return reply.status(204).send()
    },
  )
}

export default whipRoutes
