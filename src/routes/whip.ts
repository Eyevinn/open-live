import type { FastifyPluginAsync } from 'fastify'
import { getStromToken } from '../lib/strom-token.js'
import { config } from '../config.js'

/** Returns the effective TCP port for a URL, resolving protocol defaults when the port is omitted. */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

/**
 * Validates that a session URL belongs to the configured Strom host.
 * Prevents SSRF / SAT token exfiltration to an attacker-controlled host.
 */
function validateSessionUrl(sessionUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sessionUrl);
  } catch {
    throw new Error('Invalid session URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Session URL must use http or https');
  }
  const strom = new URL(config.stromUrl);
  if (parsed.hostname !== strom.hostname) {
    throw new Error('Session URL host does not match configured Strom host');
  }
  if (effectivePort(parsed) !== effectivePort(strom)) {
    throw new Error('Session URL port does not match configured Strom port');
  }
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
      let target: string;
      if (req.query.session) {
        const decoded = decodeURIComponent(req.query.session);
        try {
          validateSessionUrl(decoded);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid session URL' });
        }
        target = decoded;
      } else {
        target = resolveStromWhipUrl(req.params.id, req.params.mixerInput);
      }

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
      let target: string;
      if (req.query.session) {
        const decoded = decodeURIComponent(req.query.session);
        try {
          validateSessionUrl(decoded);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid session URL' });
        }
        target = decoded;
      } else {
        target = resolveStromWhipUrl(req.params.id, req.params.mixerInput);
      }

      const token = await getStromToken(config.stromToken).catch(() => undefined)
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      await fetch(target, { method: 'DELETE', headers }).catch(() => { /* ignore teardown errors */ })
      return reply.status(204).send()
    },
  )
}

export default whipRoutes
