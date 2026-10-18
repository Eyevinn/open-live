import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestSessionDoc, ProductionDoc, ProductionSourceAssignment } from '../db/types.js';
import { getStromToken } from '../lib/strom-token.js';
import { assertSameStromOrigin } from '../lib/url-validation.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { resolveGuestSession } from '../lib/guest-scope.js';
import { previewStromUrl, previewTarget } from '../lib/commentator-preview.js';
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
 *
 * The commentator preview routes (spec §"Commentator preview") share the same
 * server-scoped signaling proxy: an undelayed WHEP output of a source marked
 * `commentatorPreview`, its target derived from the production's
 * `previewWhepUrls`.
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

/**
 * Proxies a WHEP offer to a server-scoped Strom target (`target`, derived from
 * the production doc by the caller — never a client-supplied URL) and scopes
 * teardown back through THIS app (never a raw target param). Shared by the
 * return-picture routes — crew (`/api/v1/productions/...`) and guest alias
 * (`/api/v1/guests/:inviteId/...`, issue #423) — and the commentator preview
 * routes; `buildLocation` maps the Strom session id to the caller-appropriate
 * teardown path.
 *
 * When `bindGuestSession` is set, the guest session doc it returns for the
 * minted WHEP session id is persisted (issue #380) so the matching DELETE can
 * verify a guest caller only tears down their OWN session. Crew/API_KEY
 * callers pass none and are not bound (unchanged behaviour).
 */
async function proxyScopedWhep(args: {
  reply: FastifyReply;
  doc: ProductionDoc;
  target: string | undefined;
  /** Names the feed in the origin-check error and logs, e.g. 'Return'. */
  feed: string;
  offerSdp: string;
  buildLocation: (sessionId: string) => string;
  bindGuestSession?: (sessionId: string) => GuestSessionDoc;
}): Promise<FastifyReply> {
  const { reply, doc, target, feed, offerSdp, buildLocation, bindGuestSession } = args;
  if (doc.status !== 'active' || !doc.stromFlowId) {
    return reply.status(409).send({ error: 'production_inactive', statusCode: 409 });
  }
  if (!target) {
    return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
  }
  // Defence in depth: the derived target must be on the Strom host.
  try {
    assertSameStromOrigin(target, config.stromUrl, `${feed} target`);
  } catch {
    return reply.status(404).send({ error: 'feed_unavailable', statusCode: 404 });
  }

  const token = await getStromToken(config.stromToken).catch(() => undefined);
  const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body: offerSdp });
  } catch (err) {
    reply.log.warn({ err }, `${feed} WHEP: upstream unreachable`);
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
    reply.header('Location', buildLocation(encodeURIComponent(sessionId)));
  }
  // Bind this WHEP session id to the guest's live session (issue #380) so the
  // matching DELETE can verify a guest caller only tears down their OWN
  // session — never another guest's :sessionId. Best-effort: a persist failure
  // here does not fail the (already-established) upstream session; the guest
  // just fails closed on their next DELETE instead of silently trusting an
  // unbound id (see the DELETE handlers below).
  if (bindGuestSession && sessionId) {
    try {
      await getGuestSessionsDb().insert(bindGuestSession(sessionId));
    } catch (err) {
      reply.log.warn({ err }, `${feed} WHEP: guest session-id bind failed`);
    }
  }
  reply.header('Content-Type', 'application/sdp');
  return reply.status(201).send(answerSdp);
}

/**
 * Proxies a return-picture WHEP offer (crew route and guest alias). When
 * `guestSession` is set the minted session id is bound to it as
 * `returnWhepSessionId` (issue #380).
 */
function proxyReturnPictureWhep(args: {
  reply: FastifyReply;
  doc: ProductionDoc;
  mixerInput: string;
  offerSdp: string;
  buildLocation: (sessionId: string) => string;
  guestSession?: GuestSessionDoc;
}): Promise<FastifyReply> {
  const { mixerInput, guestSession, ...rest } = args;
  return proxyScopedWhep({
    ...rest,
    target: returnStromUrl(args.doc, mixerInput),
    feed: 'Return',
    bindGuestSession: guestSession
      ? (sessionId) => ({ ...guestSession, returnWhepSessionId: sessionId, updatedAt: new Date().toISOString() })
      : undefined,
  });
}

/**
 * Tears down a server-scoped WHEP session on Strom, rebuilding the Strom
 * resource URL from the endpoint origin + session id (the session is tied to
 * THIS feed's endpoint `base` URL, not an arbitrary target). Shared by the
 * crew and guest DELETE routes of the return picture and the commentator
 * preview; the caller is responsible for the ownership check first.
 */
async function teardownScopedWhep(
  reply: FastifyReply,
  base: string | undefined,
  sessionId: string,
): Promise<FastifyReply> {
  if (!base) return reply.status(204).send();
  const origin = new URL(base).origin;
  const target = `${origin}/whep/${encodeURIComponent(sessionId)}`;
  const token = await getStromToken(config.stromToken).catch(() => undefined);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  await fetch(target, { method: 'DELETE', headers }).catch(() => {/* ignore teardown errors */});
  return reply.status(204).send();
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
      return proxyReturnPictureWhep({
        reply,
        doc,
        mixerInput: req.params.mixerInput,
        offerSdp: req.body as string,
        buildLocation: (sessionId) =>
          `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(req.params.mixerInput)}/picture/whep/${sessionId}`,
        guestSession: req.guestScope?.session,
      });
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
      return teardownScopedWhep(reply, returnStromUrl(doc, req.params.mixerInput), req.params.sessionId);
    },
  );

  // -------------------------------------------------------------------------
  // Crew — POST/DELETE a commentator preview WHEP feed (server-scoped)
  // -------------------------------------------------------------------------
  // Shared-key only: unlike the return picture, these paths are NOT in the
  // guest-eligible families of guest-scope.ts — guests use the invite-scoped
  // aliases below.
  fastify.post<{ Params: { id: string; mixerInput: string } }>(
    '/api/v1/productions/:id/previews/:mixerInput/whep',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      return proxyScopedWhep({
        reply,
        doc,
        target: previewTarget(doc, req.params.mixerInput),
        feed: 'Preview',
        offerSdp: req.body as string,
        buildLocation: (sessionId) =>
          `/api/v1/productions/${doc._id}/previews/${encodeURIComponent(req.params.mixerInput)}/whep/${sessionId}`,
      });
    },
  );

  fastify.delete<{ Params: { id: string; mixerInput: string; sessionId: string } }>(
    '/api/v1/productions/:id/previews/:mixerInput/whep/:sessionId',
    async (req, reply) => {
      let doc: ProductionDoc;
      try {
        doc = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      return teardownScopedWhep(reply, previewStromUrl(doc, req.params.mixerInput), req.params.sessionId);
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
  ): Promise<{
    productionId: string;
    mixerInput: string;
    assignment: ProductionSourceAssignment;
    session: GuestSessionDoc;
    production: ProductionDoc;
  } | null> {
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
    return { productionId: invite.productionId, mixerInput: session.mixerInput, assignment, session, production };
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

  // -------------------------------------------------------------------------
  // Guest — return-picture WHEP aliases (token-authed; issue #423)
  // -------------------------------------------------------------------------
  // The crew signaling proxy under /api/v1/productions/... is unreachable from a
  // guest page on OSC, where the ingress gate only passes `^/api/v1/guests`
  // (osaas-app#6143). These aliases mirror the crew POST/DELETE exactly — same
  // server-scoped Strom target, same teardown binding — but keyed by :inviteId
  // with the mixerInput taken from the guest's live session.
  fastify.post<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/returns/picture/whep',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const slot = await guestReturnSlot(req, reply);
      if (!slot) return reply;
      return proxyReturnPictureWhep({
        reply,
        doc: slot.production,
        mixerInput: slot.mixerInput,
        offerSdp: req.body as string,
        buildLocation: (sessionId) =>
          `/api/v1/guests/${req.params.inviteId}/returns/picture/whep/${sessionId}`,
        guestSession: slot.session,
      });
    },
  );

  fastify.delete<{ Params: { inviteId: string; sessionId: string } }>(
    '/api/v1/guests/:inviteId/returns/picture/whep/:sessionId',
    async (req, reply) => {
      const slot = await guestReturnSlot(req, reply);
      if (!slot) return reply;
      // A guest may only tear down the WHEP session bound to THEIR OWN live
      // session (issue #380) — never another guest's :sessionId.
      if (slot.session.returnWhepSessionId !== req.params.sessionId) {
        return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
      }
      return teardownScopedWhep(reply, returnStromUrl(slot.production, slot.mixerInput), req.params.sessionId);
    },
  );

  // -------------------------------------------------------------------------
  // Guest — commentator preview WHEP (token-authed; spec §"Commentator preview")
  // -------------------------------------------------------------------------
  // A guest may watch any commentator preview of THEIR invite's production —
  // the production is taken from the invite, never from the request, so another
  // production's previews are unreachable. Needs the invite's live session, like
  // the return aliases, but not a return on the guest's own slot.
  async function guestPreviewScope(
    req: FastifyRequest<{ Params: { inviteId: string } }>,
    reply: FastifyReply,
  ): Promise<{ session: GuestSessionDoc; production: ProductionDoc } | null> {
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
    let production: ProductionDoc;
    try {
      production = await getDb().get(who.invite.productionId);
    } catch {
      await reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      return null;
    }
    return { session: who.session, production };
  }

  fastify.post<{ Params: { inviteId: string; mixerInput: string } }>(
    '/api/v1/guests/:inviteId/previews/:mixerInput/whep',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const scope = await guestPreviewScope(req, reply);
      if (!scope) return reply;
      const { session, production } = scope;
      const { mixerInput } = req.params;
      return proxyScopedWhep({
        reply,
        doc: production,
        target: previewTarget(production, mixerInput),
        feed: 'Preview',
        offerSdp: req.body as string,
        buildLocation: (sessionId) =>
          `/api/v1/guests/${req.params.inviteId}/previews/${encodeURIComponent(mixerInput)}/whep/${sessionId}`,
        bindGuestSession: (sessionId) => ({
          ...session,
          previewWhepSessionIds: { ...session.previewWhepSessionIds, [mixerInput]: sessionId },
          updatedAt: new Date().toISOString(),
        }),
      });
    },
  );

  fastify.delete<{ Params: { inviteId: string; mixerInput: string; sessionId: string } }>(
    '/api/v1/guests/:inviteId/previews/:mixerInput/whep/:sessionId',
    async (req, reply) => {
      const scope = await guestPreviewScope(req, reply);
      if (!scope) return reply;
      // A guest may only tear down the preview session bound to THEIR OWN live
      // session for this input (issue #380 pattern).
      if (scope.session.previewWhepSessionIds?.[req.params.mixerInput] !== req.params.sessionId) {
        return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
      }
      return teardownScopedWhep(reply, previewStromUrl(scope.production, req.params.mixerInput), req.params.sessionId);
    },
  );
};

export default returnsRoutes;
