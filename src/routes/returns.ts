import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestSessionsDb } from '../db/index.js';
import type { ProductionDoc, ProductionSourceAssignment } from '../db/types.js';
import { getStromToken } from '../lib/strom-token.js';
import { assertSameStromOrigin } from '../lib/url-validation.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { resolveGuestSession } from '../lib/guest-scope.js';
import { applyReturnMode } from '../ws/controller.js';
import { returnModesFor } from './guests.js';

/**
 * Per-guest return feed routes (epic #208, issue #300,
 * `docs/specs/guest-calling-intercom.md` §"Return feeds").
 *
 * A return feed is on-air program audio minus the guest (mix-minus). The picture
 * feed is program video over WHEP with exactly one audio track — that guest's
 * return aux bus. The Strom WHEP target is derived SERVER-SIDE from the
 * production doc's `returnWhepUrls` (scoped to the guest's mixerInput), never
 * `/whep-proxy?target=` which would forward to any Strom URL and so could not be
 * guest-scoped (spec §"Return feeds", §Scoping).
 */

// Only `program` / `program-minus` in v1. `low-latency-minus` is a client-side
// feed choice that is not built in v1 and returns 400 (spec §"Mode changes").
const ModeBody = z.object({
  mode: z.enum(['program', 'program-minus', 'low-latency-minus']),
});

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/** Resolve the internal Strom WHEP URL for a production's return on a mixerInput. */
function returnStromUrl(doc: ProductionDoc, mixerInput: string): string | undefined {
  return (doc.returnWhepUrls ?? []).find((r) => r.mixerInput === mixerInput)?.url;
}

/** Builds the crew/guest join-shape view of a return on an input. */
function returnView(doc: ProductionDoc, mixerInput: string) {
  const assignment = doc.sources.find((s) => s.mixerInput === mixerInput);
  const returnFeed = assignment?.returnFeed;
  const active = doc.status === 'active' && !!doc.stromFlowId;
  const feeds =
    active && returnStromUrl(doc, mixerInput)
      ? [{ id: 'picture' as const, url: `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(mixerInput)}/picture/whep`, video: true }]
      : [];
  return {
    publish: mixerInput,
    modes: returnModesFor(mixerInput),
    defaultMode: 'program-minus' as const,
    returnMode: (returnFeed?.synced ?? 'program-minus') as 'program' | 'program-minus',
    feeds,
  };
}

const returnsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addContentTypeParser('application/sdp', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // -------------------------------------------------------------------------
  // Crew — GET join shape for an input (contributor pages before invites land)
  // -------------------------------------------------------------------------
  fastify.get<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput',
    async (req, reply) => {
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const assignment = doc.sources.find((s) => s.mixerInput === req.params.mixerInput);
      if (!assignment) {
        return reply.status(404).send({ error: 'No assignment on that input', statusCode: 404 });
      }
      return reply.send(returnView(doc, req.params.mixerInput));
    },
  );

  // -------------------------------------------------------------------------
  // Crew — PUT mode (persist + apply live + broadcast RETURN_STATE)
  // -------------------------------------------------------------------------
  fastify.put<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput/mode',
    async (req, reply) => {
      const body = ModeBody.parse(req.body);
      // low-latency-minus is a client-side feed choice, not built in v1.
      if (body.mode === 'low-latency-minus') {
        return reply.status(400).send({ error: 'low-latency-minus is not available in v1', statusCode: 400 });
      }
      const result = await applyReturnMode(req.params.id, req.params.mixerInput, body.mode);
      if (!result.ok) {
        if (result.code === 'not_found') {
          return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
        }
        return reply.status(400).send({ error: 'Invalid mode', statusCode: 400 });
      }
      return reply.send({ mixerInput: result.mixerInput, mode: result.mode });
    },
  );

  // -------------------------------------------------------------------------
  // Crew — POST/DELETE the picture WHEP feed (signaling proxy, server-scoped)
  // -------------------------------------------------------------------------
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput/picture/whep',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      if (doc.status !== 'active' || !doc.stromFlowId) {
        return reply.status(409).send({ error: 'production_inactive', statusCode: 409 });
      }
      const target = returnStromUrl(doc, req.params.mixerInput);
      if (!target) {
        return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
      }
      // Defence in depth: the derived target must be on the Strom host.
      try {
        assertSameStromOrigin(target, config.stromUrl, 'Return target');
      } catch {
        return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
      }

      const token = await getStromToken(config.stromToken).catch(() => undefined);
      const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      let upstream: Response;
      try {
        upstream = await fetch(target, { method: 'POST', headers, body: req.body as string });
      } catch (err) {
        fastify.log.warn({ err }, 'return picture WHEP: upstream unreachable');
        return reply.status(503).send({ error: 'feed_unavailable', statusCode: 503 });
      }
      if (!upstream.ok) {
        return reply.status(upstream.status).send(await upstream.text());
      }
      const answerSdp = await upstream.text();
      // Scope teardown back through THIS route's session subpath (not a raw target
      // param) so a guest cannot tear down another endpoint (spec §Scoping).
      const stromLocation = upstream.headers.get('Location');
      let sessionId = '';
      if (stromLocation) {
        sessionId = stromLocation.split('/').pop() ?? '';
        reply.header(
          'Location',
          `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(req.params.mixerInput)}/picture/whep/${encodeURIComponent(sessionId)}`,
        );
      }
      // Bind this WHEP session id to the guest's live session (issue #380) so
      // the matching DELETE can verify a guest caller only tears down their
      // OWN return session — never another guest's :sessionId. Best-effort: a
      // persist failure here does not fail the (already-established) upstream
      // session; the guest just fails closed on their next DELETE instead of
      // silently trusting an unbound id (see the DELETE handler below).
      if (req.guestScope && sessionId) {
        try {
          await getGuestSessionsDb().insert({
            ...req.guestScope.session,
            returnWhepSessionId: sessionId,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          fastify.log.warn({ err }, 'return picture WHEP: guest session-id bind failed');
        }
      }
      reply.header('Content-Type', 'application/sdp');
      return reply.status(201).send(answerSdp);
    },
  );

  fastify.delete<{ Params: { id: string; mixerInput: string; sessionId: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput/picture/whep/:sessionId',
    async (req, reply) => {
      // Guest callers may only tear down the WHEP session bound to THEIR OWN
      // live session (issue #380) — the crew/API_KEY path below (unbound,
      // origin + :sessionId) is unchanged and still available to full-access
      // callers, who are trusted operators scoped by the shared API_KEY.
      if (req.guestScope) {
        if (req.guestScope.session.returnWhepSessionId !== req.params.sessionId) {
          return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
        }
      }
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const base = returnStromUrl(doc, req.params.mixerInput);
      if (!base) return reply.status(204).send();
      // Rebuild the Strom resource URL from the endpoint origin + session id — the
      // session is tied to THIS return's endpoint path, not an arbitrary target.
      const origin = new URL(base).origin;
      const target = `${origin}/whep/${encodeURIComponent(req.params.sessionId)}`;
      const token = await getStromToken(config.stromToken).catch(() => undefined);
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      await fetch(target, { method: 'DELETE', headers }).catch(() => {/* ignore teardown errors */});
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Guest — GET / PUT session/return (token-authed; PUT uses the shared mode handler)
  // -------------------------------------------------------------------------
  // Both need the invite's LIVE session and take the mixerInput from it: once a
  // guest has left, another invite may hold the slot, and a left guest's token
  // must not change what that guest hears. The guest page polls the GET to
  // follow mode changes the crew makes.
  async function guestReturnSlot(
    req: FastifyRequest<{ Params: { inviteId: string } }>,
    reply: FastifyReply,
  ): Promise<{ productionId: string; mixerInput: string; assignment: ProductionSourceAssignment } | null> {
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
    const { invite, session } = who;
    let production: ProductionDoc;
    try {
      production = await getDb().get(invite.productionId);
    } catch {
      await reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      return null;
    }
    const assignment = production.sources.find((s) => s.mixerInput === session.mixerInput);
    if (!session.mixerInput || !assignment?.returnFeed) {
      await reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      return null;
    }
    return { productionId: invite.productionId, mixerInput: session.mixerInput, assignment };
  }

  fastify.get<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/return',
    async (req, reply) => {
      const slot = await guestReturnSlot(req, reply);
      if (!slot) return reply;
      return reply.send({
        mixerInput: slot.mixerInput,
        mode: slot.assignment.returnFeed!.synced,
        modes: returnModesFor(slot.mixerInput),
        defaultMode: 'program-minus' as const,
      });
    },
  );

  fastify.put<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/return',
    async (req, reply) => {
      const body = ModeBody.parse(req.body);
      const slot = await guestReturnSlot(req, reply);
      if (!slot) return reply;
      if (body.mode === 'low-latency-minus') {
        return reply.status(400).send({ error: 'low-latency-minus is not available in v1', statusCode: 400 });
      }
      const result = await applyReturnMode(slot.productionId, slot.mixerInput, body.mode);
      if (!result.ok) {
        return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      }
      return reply.send({ mixerInput: result.mixerInput, mode: result.mode });
    },
  );
};

export default returnsRoutes;
