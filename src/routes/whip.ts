import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { getStromToken } from '../lib/strom-token.js'
import { assertSameStromOrigin } from '../lib/url-validation.js'
import { isUnderEndpointPath, resolveGuestSession } from '../lib/guest-scope.js'
import { config, isGuestCallingEnabled } from '../config.js'

/**
 * Validates that a session URL belongs to the configured Strom host.
 * Prevents SSRF / SAT token exfiltration to an attacker-controlled host.
 */
function validateSessionUrl(sessionUrl: string): void {
  assertSameStromOrigin(sessionUrl, config.stromUrl, 'Session URL');
}

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

type TargetResolution =
  | { ok: true; target: string }
  | { ok: false; status: number; body: { error: string; statusCode?: number } }

/**
 * Resolves the Strom WHIP target for a PATCH/DELETE call.
 *
 * `session` is client-supplied, and `validateSessionUrl` only checks it is
 * on the Strom host — not that it belongs to THIS caller (issue #380). For a
 * guest caller (`guestScoped`) that is not enough: a guest could otherwise
 * PATCH/DELETE another guest's session by supplying its URL. So for guest
 * callers we additionally require the decoded session URL's path to be the
 * scoped endpoint (`resolveStromWhipUrl(productionId, mixerInput)`) or a
 * sub-path of it — rejecting anything else with 403. Crew/API_KEY callers are
 * unaffected (unchanged behaviour — full access, any mixerInput).
 */
function resolveWhipSessionTarget(opts: {
  session: string | undefined
  productionId: string
  mixerInput: string
  guestScoped: boolean
}): TargetResolution {
  if (!opts.session) {
    return { ok: true, target: resolveStromWhipUrl(opts.productionId, opts.mixerInput) }
  }
  const decoded = decodeURIComponent(opts.session)
  try {
    validateSessionUrl(decoded)
  } catch (err) {
    return {
      ok: false,
      status: 400,
      body: { error: err instanceof Error ? err.message : 'Invalid session URL' },
    }
  }
  if (opts.guestScoped) {
    const expectedEndpoint = resolveStromWhipUrl(opts.productionId, opts.mixerInput)
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
 * Crew (API_KEY):
 *   POST   /api/v1/productions/:id/whip/:mixerInput
 *   PATCH  /api/v1/productions/:id/whip/:mixerInput?session=<encoded>
 *   DELETE /api/v1/productions/:id/whip/:mixerInput?session=<encoded>
 *
 * Guest (per-invite token; issue #423): same proxy keyed by :inviteId, with the
 * mixerInput taken from the guest's live session. Needed because the OSC ingress
 * gate only passes `^/api/v1/guests` (osaas-app#6143), so the crew
 * `/api/v1/productions/...` path is unreachable from the guest page.
 *   POST   /api/v1/guests/:inviteId/whip
 *   PATCH  /api/v1/guests/:inviteId/whip?session=<encoded>
 *   DELETE /api/v1/guests/:inviteId/whip?session=<encoded>
 */

/** Derives the Strom WHIP endpoint URL for a given production + mixerInput. */
export function resolveStromWhipUrl(productionId: string, mixerInput: string): string {
  const padMatch = /video_in_(\d+)$/.exec(mixerInput)
  const padIndex = padMatch ? parseInt(padMatch[1], 10) : 0
  const endpointSuffix = productionId.replace(/^prod-/, '').slice(0, 8)
  return `${config.stromUrl}/whip/whip-${padIndex}-${endpointSuffix}`
}

/**
 * Forwards an initial WHIP offer to Strom and rewrites the session Location so
 * subsequent ICE/teardown requests come back through this proxy. `buildProxyLocation`
 * maps the absolute Strom session URL to the caller-appropriate proxy path (crew
 * vs. guest), which is the only part of the flow that differs between the two.
 */
async function proxyWhipOffer(
  reply: FastifyReply,
  productionId: string,
  mixerInput: string,
  offerSdp: string,
  buildProxyLocation: (absoluteStromLocation: string) => string,
): Promise<FastifyReply> {
  const stromTarget = resolveStromWhipUrl(productionId, mixerInput)

  const token = await getStromToken(config.stromToken).catch(() => undefined)
  const headers: Record<string, string> = { 'Content-Type': 'application/sdp' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const upstream = await fetch(stromTarget, { method: 'POST', headers, body: offerSdp })

  if (!upstream.ok) {
    return reply.status(upstream.status).send(await upstream.text())
  }

  const answerSdp = await upstream.text()

  const stromLocation = upstream.headers.get('Location')
  if (stromLocation) {
    const absoluteStromLocation = stromLocation.startsWith('http')
      ? stromLocation
      : `${new URL(stromTarget).origin}${stromLocation}`
    reply.header('Location', buildProxyLocation(absoluteStromLocation))
  }

  reply.header('Content-Type', 'application/sdp')
  return reply.status(201).send(answerSdp)
}

/** Forwards an ICE trickle fragment to an already-resolved Strom session target. */
async function proxyWhipPatch(reply: FastifyReply, target: string, fragment: string): Promise<FastifyReply> {
  const token = await getStromToken(config.stromToken).catch(() => undefined)
  const headers: Record<string, string> = {
    'Content-Type': 'application/trickle-ice-sdpfrag',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const upstream = await fetch(target, { method: 'PATCH', headers, body: fragment })
  return reply.status(upstream.status).send()
}

/** Tears down an already-resolved Strom WHIP session target. */
async function proxyWhipDelete(reply: FastifyReply, target: string): Promise<FastifyReply> {
  const token = await getStromToken(config.stromToken).catch(() => undefined)
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  await fetch(target, { method: 'DELETE', headers }).catch(() => { /* ignore teardown errors */ })
  return reply.status(204).send()
}

/**
 * Resolves the guest's own (productionId, mixerInput) from their per-invite
 * token for the guest-scoped WHIP aliases (issue #423). Mirrors the token check
 * in `guests.ts`/`returns.ts` guest handlers: the token must be valid and live,
 * and its invite must match the :inviteId in the path. The mixerInput comes from
 * the LIVE session (never the invite), so a left guest's token cannot change
 * what the current slot holder publishes. Writes the reply and returns null on
 * any failure.
 */
async function resolveGuestWhipSlot(
  req: FastifyRequest<{ Params: { inviteId: string } }>,
  reply: FastifyReply,
): Promise<{ productionId: string; mixerInput: string } | null> {
  if (!isGuestCallingEnabled()) {
    await reply.status(503).send({ error: 'Guest calling is disabled', statusCode: 503 });
    return null;
  }
  const token = bearerToken(req);
  const who = token ? await resolveGuestSession(token) : undefined;
  if (!who?.ok || who.invite._id !== req.params.inviteId) {
    await reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
    return null;
  }
  if (!who.session.mixerInput) {
    await reply.status(404).send({ error: 'No guest slot on this session', statusCode: 404 });
    return null;
  }
  return { productionId: who.invite.productionId, mixerInput: who.session.mixerInput };
}

const whipRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })
  fastify.addContentTypeParser('application/trickle-ice-sdpfrag', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body)
  })

  // -------------------------------------------------------------------------
  // Crew (API_KEY) — /api/v1/productions/:id/whip/:mixerInput
  // -------------------------------------------------------------------------

  // POST — initial WHIP offer/answer
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id: productionId, mixerInput } = req.params
      return proxyWhipOffer(
        reply,
        productionId,
        mixerInput,
        req.body as string,
        (absoluteStromLocation) =>
          `/api/v1/productions/${productionId}/whip/${encodeURIComponent(mixerInput)}` +
          `?session=${encodeURIComponent(absoluteStromLocation)}`,
      )
    },
  )

  // PATCH — ICE trickle update
  fastify.patch<{
    Params: { id: string; mixerInput: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    async (req, reply) => {
      const resolved = resolveWhipSessionTarget({
        session: req.query.session,
        productionId: req.params.id,
        mixerInput: req.params.mixerInput,
        guestScoped: !!req.guestScope,
      })
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      return proxyWhipPatch(reply, resolved.target, req.body as string)
    },
  )

  // DELETE — teardown
  fastify.delete<{
    Params: { id: string; mixerInput: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/productions/:id/whip/:mixerInput',
    async (req, reply) => {
      const resolved = resolveWhipSessionTarget({
        session: req.query.session,
        productionId: req.params.id,
        mixerInput: req.params.mixerInput,
        guestScoped: !!req.guestScope,
      })
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      return proxyWhipDelete(reply, resolved.target)
    },
  )

  // -------------------------------------------------------------------------
  // Guest (per-invite token — exempt from shared API_KEY in server.ts) — aliases
  // under /api/v1/guests/:inviteId/whip so the guest page reaches WHIP through
  // the OSC ingress-gated path (issue #423, osaas-app#6143).
  // -------------------------------------------------------------------------

  // POST — initial WHIP offer/answer
  fastify.post<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/whip',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const slot = await resolveGuestWhipSlot(req, reply)
      if (!slot) return reply
      return proxyWhipOffer(
        reply,
        slot.productionId,
        slot.mixerInput,
        req.body as string,
        (absoluteStromLocation) =>
          `/api/v1/guests/${req.params.inviteId}/whip` +
          `?session=${encodeURIComponent(absoluteStromLocation)}`,
      )
    },
  )

  // PATCH — ICE trickle update
  fastify.patch<{
    Params: { inviteId: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/guests/:inviteId/whip',
    async (req, reply) => {
      const slot = await resolveGuestWhipSlot(req, reply)
      if (!slot) return reply
      const resolved = resolveWhipSessionTarget({
        session: req.query.session,
        productionId: slot.productionId,
        mixerInput: slot.mixerInput,
        guestScoped: true,
      })
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      return proxyWhipPatch(reply, resolved.target, req.body as string)
    },
  )

  // DELETE — teardown
  fastify.delete<{
    Params: { inviteId: string }
    Querystring: { session?: string }
  }>(
    '/api/v1/guests/:inviteId/whip',
    async (req, reply) => {
      const slot = await resolveGuestWhipSlot(req, reply)
      if (!slot) return reply
      const resolved = resolveWhipSessionTarget({
        session: req.query.session,
        productionId: slot.productionId,
        mixerInput: slot.mixerInput,
        guestScoped: true,
      })
      if (!resolved.ok) {
        return reply.status(resolved.status).send(resolved.body)
      }
      return proxyWhipDelete(reply, resolved.target)
    },
  )
}

export default whipRoutes
