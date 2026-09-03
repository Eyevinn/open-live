import type { FastifyPluginAsync } from 'fastify';
import { getStromToken } from '../lib/strom-token.js';
import { config } from '../config.js';

/** Returns the effective TCP port for a URL, resolving protocol defaults when the port is omitted. */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' ? '443' : '80';
}

/** Validates a proxy target URL is on the configured Strom host (prevents SSRF + token exfiltration). */
function validateProxyTarget(targetUrl: string): void {
  let parsed: URL;
  try { parsed = new URL(targetUrl); } catch { throw new Error('Invalid target URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Target URL must use http or https');
  }
  const strom = new URL(config.stromUrl);
  if (parsed.hostname !== strom.hostname) {
    throw new Error('Target URL host does not match configured Strom host');
  }
  if (effectivePort(parsed) !== effectivePort(strom)) {
    throw new Error('Target URL port does not match configured Strom port');
  }
}

/**
 * WHEP signaling proxy — forwards SDP offer/answer and teardown to Strom.
 *
 * The browser cannot reach Strom directly: OSC-hosted Strom is behind auth
 * (SAT token) and does not allow CORS from localhost. This proxy adds the
 * token and forwards the request server-side.
 *
 * POST /api/v1/whep-proxy?target={encodeURIComponent(stromWhepUrl)}
 *   Body: raw SDP offer (text/plain or application/sdp)
 *   Returns: SDP answer + Location header pointing back through this proxy
 *
 * DELETE /api/v1/whep-proxy?target={encodeURIComponent(stromResourceUrl)}
 *   Tears down the WHEP session on Strom
 */
const whepProxyRoutes: FastifyPluginAsync = async (fastify) => {
  // Accept raw SDP body
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })
  fastify.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  fastify.post<{ Querystring: { target: string } }>(
    '/api/v1/whep-proxy',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
    const target = req.query.target
    if (!target) return reply.status(400).send({ error: 'Missing target query parameter' })

    let targetUrl: string
    try {
      targetUrl = decodeURIComponent(target)
      validateProxyTarget(targetUrl)
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid target URL' })
    }

    const token = await getStromToken(config.stromToken).catch(() => undefined)
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    let upstream: Response
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: req.body as string,
      })
    } catch (err) {
      fastify.log.warn({ err }, 'WHEP proxy: upstream unreachable')
      return reply.status(502).send({ error: 'Upstream unreachable' })
    }

    if (!upstream.ok) {
      const text = await upstream.text()
      return reply.status(upstream.status).send(text)
    }

    const answerSdp = await upstream.text()

    // Rewrite the Location header so the browser uses our proxy for teardown.
    // Strom may return a relative path — resolve it to an absolute URL first.
    const stromLocation = upstream.headers.get('Location')
    if (stromLocation) {
      const absoluteLocation = stromLocation.startsWith('http')
        ? stromLocation
        : `${new URL(targetUrl).origin}${stromLocation}`
      const proxyLocation = `/api/v1/whep-proxy?target=${encodeURIComponent(absoluteLocation)}`
      reply.header('Location', proxyLocation)
    }

    reply.header('Content-Type', 'application/sdp')
    return reply.status(201).send(answerSdp)
  })

  fastify.delete<{ Querystring: { target: string } }>('/api/v1/whep-proxy', async (req, reply) => {
    const target = req.query.target
    if (!target) return reply.status(400).send({ error: 'Missing target query parameter' })

    let targetUrl: string
    try {
      targetUrl = decodeURIComponent(target)
      validateProxyTarget(targetUrl)
    } catch (err) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid target URL' })
    }

    const token = await getStromToken(config.stromToken).catch(() => undefined)
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    await fetch(targetUrl, { method: 'DELETE', headers }).catch(() => {/* ignore teardown errors */})
    return reply.status(204).send()
  })
}

export default whepProxyRoutes
