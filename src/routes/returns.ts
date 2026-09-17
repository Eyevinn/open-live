import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, getGuestInvitesDb } from '../db/index.js';
import type { GuestInviteDoc, ProductionDoc } from '../db/types.js';
import { getStromToken } from '../lib/strom-token.js';
import { assertSameStromOrigin } from '../lib/url-validation.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { verifyGuestInviteToken, hashGuestInviteToken } from '../lib/guest-invite-token.js';
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
      if (stromLocation) {
        const sessionId = stromLocation.split('/').pop() ?? '';
        reply.header(
          'Location',
          `/api/v1/productions/${doc._id}/returns/${encodeURIComponent(req.params.mixerInput)}/picture/whep/${encodeURIComponent(sessionId)}`,
        );
      }
      reply.header('Content-Type', 'application/sdp');
      return reply.status(201).send(answerSdp);
    },
  );

  fastify.delete<{ Params: { id: string; mixerInput: string; sessionId: string } }>(
    '/api/v1/productions/:id/returns/:mixerInput/picture/whep/:sessionId',
    async (req, reply) => {
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
  // Guest — PUT session/return (token-authed; same shared mode handler)
  // -------------------------------------------------------------------------
  fastify.put<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/return',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) {
        return reply.status(503).send({ error: 'Guest calling is disabled', statusCode: 503 });
      }
      const body = ModeBody.parse(req.body);
      if (body.mode === 'low-latency-minus') {
        return reply.status(400).send({ error: 'low-latency-minus is not available in v1', statusCode: 400 });
      }
      const secret = config.guestInviteSecret!;
      const token = bearerToken(req);
      if (!token) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      const verified = verifyGuestInviteToken(token, secret);
      if (!verified.ok || verified.claims.inviteId !== req.params.inviteId) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      let invite: GuestInviteDoc;
      try {
        invite = await getGuestInvitesDb().get(req.params.inviteId);
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      if (invite.tokenHash !== hashGuestInviteToken(token)) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }

      // The guest's live session pins its mixerInput — the token is scoped to it.
      let production: ProductionDoc;
      try {
        production = await getDb().get(invite.productionId);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const assignment = production.sources.find(
        (s) => s.mixerInput === invite.mixerInput,
      );
      if (!invite.mixerInput || !assignment?.returnFeed) {
        return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      }
      const result = await applyReturnMode(invite.productionId, invite.mixerInput, body.mode);
      if (!result.ok) {
        return reply.status(404).send({ error: 'No return on that input', statusCode: 404 });
      }
      return reply.send({ mixerInput: result.mixerInput, mode: result.mode });
    },
  );
};

export default returnsRoutes;
