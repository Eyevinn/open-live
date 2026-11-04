import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestSessionDoc, ProductionDoc, ProductionSourceAssignment } from '../db/types.js';
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

// Only `program` / `program-minus` change the mix. `low-latency-minus` is a
// client-side feed choice (play the fast feed) and returns 400 (spec §"Mode changes").
const ModeBody = z.object({
  mode: z.enum(['program', 'program-minus', 'low-latency-minus']),
});

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

type FeedId = 'picture' | 'fast';

/** Resolve the internal Strom WHEP URL for one of a production's return feeds on a mixerInput. */
function returnStromUrl(doc: ProductionDoc, mixerInput: string, feed: FeedId = 'picture'): string | undefined {
  const urls = feed === 'fast' ? doc.fastWhepUrls : doc.returnWhepUrls;
  return (urls ?? []).find((r) => r.mixerInput === mixerInput)?.url;
}

/** True when the production is active and has a fast feed for `mixerInput`. */
function fastFeedLive(doc: ProductionDoc, mixerInput: string): boolean {
  return doc.status === 'active' && !!doc.stromFlowId && !!returnStromUrl(doc, mixerInput, 'fast');
}

/** Guest-session field that binds the guest's WHEP session id for a feed. */
const SESSION_FIELD = { picture: 'returnWhepSessionId', fast: 'fastWhepSessionId' } as const;

const MAX_BIND_ATTEMPTS = 3;

/**
 * Writes one feed's WHEP session id onto the guest session. Re-reads the doc on
 * every attempt and retries a 409: a client opens the picture and fast feeds
 * together, and a write from a stale snapshot would drop the other feed's binding.
 */
async function bindGuestWhepSession(sessionDocId: string, feed: FeedId, whepSessionId: string): Promise<void> {
  const db = getGuestSessionsDb();
  for (let attempt = 1; ; attempt++) {
    try {
      const current = await db.get(sessionDocId);
      await db.insert({ ...current, [SESSION_FIELD[feed]]: whepSessionId, updatedAt: new Date().toISOString() });
      return;
    } catch (err) {
      const conflict = (err as { statusCode?: number }).statusCode === 409;
      if (!conflict || attempt >= MAX_BIND_ATTEMPTS) throw err;
    }
  }
}

/** Builds the crew/guest join-shape view of a return on an input. */
function returnView(doc: ProductionDoc, mixerInput: string) {
  const assignment = doc.sources.find((s) => s.mixerInput === mixerInput);
  const returnFeed = assignment?.returnFeed;
  const active = doc.status === 'active' && !!doc.stromFlowId;
  const base = `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(mixerInput)}`;
  const feeds: Array<{ id: FeedId; url: string; video: boolean }> = [];
  if (active && returnStromUrl(doc, mixerInput)) feeds.push({ id: 'picture', url: `${base}/picture/whep`, video: true });
  const fast = fastFeedLive(doc, mixerInput);
  if (fast) feeds.push({ id: 'fast', url: `${base}/fast/whep`, video: false });
  return {
    publish: mixerInput,
    modes: returnModesFor(mixerInput, fast),
    defaultMode: 'program-minus' as const,
    returnMode: (returnFeed?.synced ?? 'program-minus') as 'program' | 'program-minus',
    feeds,
  };
}

/**
 * Proxies a return WHEP offer (picture or fast feed) to the production's
 * server-scoped Strom target and scopes teardown back through THIS app (never
 * a raw target param).
 * Shared by the crew route (`/api/v1/productions/...`) and the guest alias
 * (`/api/v1/guests/:inviteId/...`, issue #423); `buildLocation` maps the Strom
 * session id to the caller-appropriate teardown path, the only part that differs.
 *
 * When `guestSession` is set the minted WHEP session id is bound to that guest's
 * live session (issue #380) so the matching DELETE can verify a guest caller
 * only tears down their OWN return session. Crew/API_KEY callers pass no
 * `guestSession` and are not bound (unchanged behaviour).
 */
async function proxyReturnWhep(args: {
  reply: FastifyReply;
  doc: ProductionDoc;
  mixerInput: string;
  feed: FeedId;
  offerSdp: string;
  buildLocation: (sessionId: string) => string;
  guestSession?: GuestSessionDoc;
}): Promise<FastifyReply> {
  const { reply, doc, mixerInput, feed, offerSdp, buildLocation, guestSession } = args;
  if (doc.status !== 'active' || !doc.stromFlowId) {
    return reply.status(409).send({ error: 'production_inactive', statusCode: 409 });
  }
  const target = returnStromUrl(doc, mixerInput, feed);
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
    upstream = await fetch(target, { method: 'POST', headers, body: offerSdp });
  } catch (err) {
    reply.log.warn({ err, feed }, 'return WHEP: upstream unreachable');
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
  // matching DELETE can verify a guest caller only tears down their OWN return
  // session — never another guest's :sessionId. Best-effort: a persist failure
  // here does not fail the (already-established) upstream session; the guest
  // just fails closed on their next DELETE instead of silently trusting an
  // unbound id (see the DELETE handlers below).
  if (guestSession && sessionId) {
    try {
      await bindGuestWhepSession(guestSession._id, feed, sessionId);
    } catch (err) {
      reply.log.warn({ err, feed }, 'return WHEP: guest session-id bind failed');
    }
  }
  reply.header('Content-Type', 'application/sdp');
  return reply.status(201).send(answerSdp);
}

/**
 * Tears down a return WHEP session on Strom, rebuilding the Strom
 * resource URL from the endpoint origin + session id (the session is tied to
 * THIS return's endpoint path, not an arbitrary target). Shared by the crew and
 * guest DELETE routes; the caller is responsible for the ownership check first.
 */
async function teardownReturnWhep(
  reply: FastifyReply,
  doc: ProductionDoc,
  mixerInput: string,
  feed: FeedId,
  sessionId: string,
): Promise<FastifyReply> {
  const base = returnStromUrl(doc, mixerInput, feed);
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
  // Crew — POST/DELETE the picture and fast WHEP feeds (signaling proxy, server-scoped)
  // -------------------------------------------------------------------------
  for (const feed of ['picture', 'fast'] as const) {
    fastify.post<{ Params: { id: string; mixerInput: string } }>(
      `/api/v1/productions/:id/returns/:mixerInput/${feed}/whep`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        let doc: ProductionDoc;
        try {
          doc = await getDb().get(req.params.id);
        } catch {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        return proxyReturnWhep({
          reply,
          doc,
          mixerInput: req.params.mixerInput,
          feed,
          offerSdp: req.body as string,
          buildLocation: (sessionId) =>
            `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(req.params.mixerInput)}/${feed}/whep/${sessionId}`,
          guestSession: req.guestScope?.session,
        });
      },
    );

    fastify.delete<{ Params: { id: string; mixerInput: string; sessionId: string } }>(
      `/api/v1/productions/:id/returns/:mixerInput/${feed}/whep/:sessionId`,
      async (req, reply) => {
        // Guest callers may only tear down the WHEP session bound to THEIR OWN
        // live session (issue #380) — the crew/API_KEY path below (unbound,
        // origin + :sessionId) is unchanged and still available to full-access
        // callers, who are trusted operators scoped by the shared API_KEY.
        if (req.guestScope) {
          if (req.guestScope.session[SESSION_FIELD[feed]] !== req.params.sessionId) {
            return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
          }
        }
        let doc: ProductionDoc;
        try {
          doc = await getDb().get(req.params.id);
        } catch {
          return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
        }
        return teardownReturnWhep(reply, doc, req.params.mixerInput, feed, req.params.sessionId);
      },
    );
  }

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
        modes: returnModesFor(slot.mixerInput, fastFeedLive(slot.production, slot.mixerInput)),
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
  // Guest — return WHEP aliases, picture and fast (token-authed; issue #423)
  // -------------------------------------------------------------------------
  // The crew signaling proxy under /api/v1/productions/... is unreachable from a
  // guest page on OSC, where the ingress gate only passes `^/api/v1/guests`
  // (osaas-app#6143). These aliases mirror the crew POST/DELETE exactly — same
  // server-scoped Strom target, same teardown binding — but keyed by :inviteId
  // with the mixerInput taken from the guest's live session.
  for (const feed of ['picture', 'fast'] as const) {
    fastify.post<{ Params: { inviteId: string } }>(
      `/api/v1/guests/:inviteId/returns/${feed}/whep`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        const slot = await guestReturnSlot(req, reply);
        if (!slot) return reply;
        return proxyReturnWhep({
          reply,
          doc: slot.production,
          mixerInput: slot.mixerInput,
          feed,
          offerSdp: req.body as string,
          buildLocation: (sessionId) =>
            `/api/v1/guests/${req.params.inviteId}/returns/${feed}/whep/${sessionId}`,
          guestSession: slot.session,
        });
      },
    );

    fastify.delete<{ Params: { inviteId: string; sessionId: string } }>(
      `/api/v1/guests/:inviteId/returns/${feed}/whep/:sessionId`,
      async (req, reply) => {
        const slot = await guestReturnSlot(req, reply);
        if (!slot) return reply;
        // A guest may only tear down the WHEP session bound to THEIR OWN live
        // session (issue #380) — never another guest's :sessionId.
        if (slot.session[SESSION_FIELD[feed]] !== req.params.sessionId) {
          return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
        }
        return teardownReturnWhep(reply, slot.production, slot.mixerInput, feed, req.params.sessionId);
      },
    );
  }
};

export default returnsRoutes;
