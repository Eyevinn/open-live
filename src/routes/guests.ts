import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  getDb,
  getGuestInvitesDb,
  getGuestSessionsDb,
} from '../db/index.js';
import type {
  GuestInviteDoc,
  GuestSessionDoc,
  ProductionDoc,
} from '../db/types.js';
import {
  generateGuestInviteToken,
  verifyGuestInviteToken,
  hashGuestInviteToken,
} from '../lib/guest-invite-token.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { broadcast } from '../services/tally.service.js';
import { resolvePublicBaseUrl, updateProductionDoc } from './productions.js';
import {
  isIntercomEnabled,
  provisionGuestLine,
  IntercomManagerError,
  type IntercomLine,
} from '../lib/intercom-manager.js';

/**
 * Guest calling — production-scoped invites + token-authed guest join
 * (epic #208, issue #299, `docs/specs/guest-calling-intercom.md`
 * §"Guest invites", §"Guest join", §"Guest management").
 *
 * Auth model (spec §"API Design", §Risks):
 *   - Invite-management + guest-management routes are under `/api/v1/productions`
 *     and sit behind the shared `API_KEY` bearer gate (server.ts onRequest hook),
 *     exactly like `/api/v1/sources` — operator/automation surfaces.
 *   - The guest JOIN / SESSION routes (`/api/v1/guests/:inviteId/...`) are
 *     exempted from the shared key in server.ts and authenticate with the
 *     per-invite HMAC token verified here. That token grants only WHIP publish
 *     into this guest's mixer input for one production — a leaked token is
 *     short-lived, stored only as a hash, and revocable by DELETE.
 *
 * Take-to-air / preview is NOT implemented here: a guest is a WHIP source on a
 * mixer input, so the existing vision-mixer `SET_PVW` / `TAKE` already switch it.
 * Guest lifecycle WS events (`GUEST_STATE`) are broadcast from here on the
 * persisted join/leave/kick transitions (issue #301); return-feed mode changes
 * and the connect-time snapshot live in the WS controller.
 */

// ---------------------------------------------------------------------------
// zod schemas
// ---------------------------------------------------------------------------

const CreateInviteBody = z.object({
  label: z.string().min(1).max(256).optional(),
  /** Override the default TTL. Bounded to keep invites short-lived (spec §Risks). */
  expiresInS: z.number().int().min(60).max(7 * 86400).optional(),
  /** Optional pre-allocated input the guest will occupy; allocated on join if absent. */
  mixerInput: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Return-feed metadata (stable contract; feed URLs land in a later sub-issue)
// ---------------------------------------------------------------------------

/**
 * The guest return modes advertised on join. v1 ships `program` and
 * `program-minus` (synced, picture-switch delivery); `low-latency-minus` is
 * declared but gated off (spec §"Return feed design", §"Low-latency mode").
 * `defaultMode` is `program-minus` per OQ2 (@svensson00, #208).
 */
export function returnModesFor(mixerInput: string) {
  return [
    {
      key: 'program' as const,
      label: 'Program',
      synced: true,
      delivery: { kind: 'picture-switch' as const },
    },
    {
      key: 'program-minus' as const,
      label: 'Program minus me',
      synced: true,
      excludesMixerInput: mixerInput,
      delivery: { kind: 'picture-switch' as const },
    },
  ];
}

// ---------------------------------------------------------------------------
// toApi projections (match sources/gateways convention: `_id` → `id`, strip meta)
// ---------------------------------------------------------------------------

function inviteToApi(doc: GuestInviteDoc) {
  const { _id, _rev, type, tokenHash, ...rest } = doc;
  void _rev;
  void type;
  void tokenHash; // never leak the hash to clients
  return { id: _id, ...rest };
}

function sessionToApi(doc: GuestSessionDoc) {
  const { _id, _rev, type, ...rest } = doc;
  void _rev;
  void type;
  return { id: _id, ...rest };
}

/**
 * Broadcast a GUEST_STATE lifecycle event to a production's controller
 * subscribers (epic #208, issue #301). Emitted on the persisted transitions
 * (`joined` on join, `left` on leave/kick). previewing/on-air are derived on
 * the WS controller connect snapshot from the live tally, not re-derived here.
 */
function broadcastGuestState(session: GuestSessionDoc, label?: string): void {
  broadcast(session.productionId, {
    type: 'GUEST_STATE',
    guestId: session._id,
    mixerInput: session.mixerInput,
    state: session.state,
    ...(label ? { label } : {}),
    ...(session.intercomLineId ? { intercomLine: session.intercomLineId } : {}),
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/** 503 when the HMAC secret is unset — guest calling is disabled (spec §Configuration). */
function guestsDisabled(): { error: string; statusCode: 503 } {
  return {
    error: 'Guest calling is disabled — set GUEST_INVITE_SECRET to enable it',
    statusCode: 503,
  };
}

const guestsRoutes: FastifyPluginAsync = async (fastify) => {
  // -------------------------------------------------------------------------
  // Invites (production-scoped, API_KEY gated)
  // -------------------------------------------------------------------------

  // Create an invite — mints the raw token (returned exactly once) and stores
  // only its hash.
  fastify.post<{ Params: { id: string } }>(
    '/api/v1/productions/:id/guests/invites',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = config.guestInviteSecret!;
      const body = CreateInviteBody.parse(req.body);

      // 404 if the production does not exist.
      try {
        await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }

      const inviteId = `guest-invite-${randomUUID()}`;
      const ttlS = body.expiresInS ?? config.guestInviteTtlS;
      const now = Date.now();
      const expiresAt = new Date(now + ttlS * 1000).toISOString();
      const { token, tokenHash } = generateGuestInviteToken(
        { inviteId, productionId: req.params.id, exp: Math.floor(now / 1000) + ttlS },
        secret,
      );

      const doc: GuestInviteDoc = {
        _id: inviteId,
        type: 'guest-invite',
        productionId: req.params.id,
        tokenHash,
        ...(body.label ? { label: body.label } : {}),
        ...(body.mixerInput ? { mixerInput: body.mixerInput } : {}),
        expiresAt,
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      };
      try {
        await getGuestInvitesDb().insert(doc);
      } catch (err) {
        fastify.log.warn({ err }, 'POST guests/invites — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }

      const base = resolvePublicBaseUrl(req);
      const joinUrl = `${base}/api/v1/guests/${inviteId}/join`;
      // The raw token is returned here and NEVER again — only its hash is stored.
      return reply.status(201).send({
        id: inviteId,
        productionId: req.params.id,
        joinUrl,
        token,
        expiresAt,
        ...(doc.mixerInput ? { mixerInput: doc.mixerInput } : {}),
      });
    },
  );

  // List invites for a production.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/guests/invites',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      try {
        await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const db = getGuestInvitesDb();
      let result: Awaited<ReturnType<typeof db.find>>;
      try {
        // find() (not findTrusted): productionId is user-supplied. The Mango
        // injection guard rejects any `$`-operator smuggled through it (#64).
        result = await db.find({
          selector: { type: 'guest-invite', productionId: req.params.id },
        });
      } catch (err) {
        fastify.log.warn({ err }, 'GET guests/invites — DB query failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(inviteToApi));
    },
  );

  // Revoke an invite (per-invite revocation — spec §Risks).
  fastify.delete<{ Params: { id: string; inviteId: string } }>(
    '/api/v1/productions/:id/guests/invites/:inviteId',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      let doc: GuestInviteDoc;
      try {
        doc = await getGuestInvitesDb().get(req.params.inviteId);
      } catch {
        return reply.status(404).send({ error: 'Invite not found', statusCode: 404 });
      }
      // 403 if the invite belongs to a different production (spec §"Error codes").
      if (doc.productionId !== req.params.id) {
        return reply.status(403).send({ error: 'Invite is for a different production', statusCode: 403 });
      }
      try {
        await getGuestInvitesDb().destroy(doc._id, doc._rev!);
      } catch (err) {
        fastify.log.warn({ err }, 'DELETE guests/invites — DB delete failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Guest join / session (token-authed — exempt from shared API_KEY in server.ts)
  // -------------------------------------------------------------------------

  fastify.post<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/join',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = config.guestInviteSecret!;
      const token = bearerToken(req);
      if (!token) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }

      // 1. Verify signature + expiry cryptographically (no DB hit).
      const verified = verifyGuestInviteToken(token, secret);
      if (!verified.ok) {
        // Expired vs. malformed/forged both read as "invalid or expired invite"
        // to a client (spec §"Error codes": 401). Capacity/expiry-after-lookup
        // is 409 below.
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      // The token's inviteId claim must match the path (defence in depth).
      if (verified.claims.inviteId !== req.params.inviteId) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }

      // 2. Load the invite doc and compare the stored hash (revocation via DELETE
      //    removes the doc even while the signature is still valid).
      let invite: GuestInviteDoc;
      try {
        invite = await getGuestInvitesDb().get(req.params.inviteId);
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      if (invite.tokenHash !== hashGuestInviteToken(token)) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      // Belt-and-braces: the persisted expiry (409 = expired, spec §"Error codes").
      if (Date.parse(invite.expiresAt) <= Date.now()) {
        return reply.status(409).send({ error: 'Invite expired', statusCode: 409 });
      }

      // 3. Resolve the production (404 if gone) and the guest's mixer input.
      let production: ProductionDoc;
      try {
        production = await getDb().get(invite.productionId);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      // Block a join to a production whose broadcast has ended (deactivated —
      // issue #325). Deactivate revokes outstanding invites, but a still-TTL-valid
      // token must not be able to redeem a fresh session (and provision a fresh
      // intercom line) against a finished production. `inactive`/`activating`
      // remain joinable — invites are minted before a production goes live.
      if (production.status === 'ended') {
        return reply.status(409).send({ error: 'Production is not active', statusCode: 409 });
      }
      // Allocate a mixer input if the invite did not pin one: reuse the invite's
      // preset, else the first unassigned `video_in_N` on the production.
      const mixerInput = invite.mixerInput ?? allocateMixerInput(production);

      // 4. Create (or reuse) the guest session for this invite. A rejoin on the
      //    same invite reuses the existing non-`left` session so a reconnect does
      //    not orphan sessions.
      const now = new Date().toISOString();
      let session: GuestSessionDoc;
      try {
        const existing = await getGuestSessionsDb().find({
          selector: { type: 'guest-session', inviteId: invite._id },
        });
        const live = (Array.isArray(existing?.docs) ? existing.docs : []).find(
          (s) => s.state !== 'left',
        );
        if (live) {
          session = { ...live, mixerInput, state: 'joined', updatedAt: now };
        } else {
          session = {
            _id: `guest-session-${randomUUID()}`,
            type: 'guest-session',
            productionId: invite.productionId,
            inviteId: invite._id,
            mixerInput,
            state: 'joined',
            createdAt: now,
            updatedAt: now,
          };
        }
        await getGuestSessionsDb().insert(session);
      } catch (err) {
        fastify.log.warn({ err }, 'POST guests/:id/join — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }

      // 5a. Ensure the guest's assignment carries a return feed (issue #300). The
      //    return belongs to the assignment, so a rejoin keeps it; default is
      //    program-minus (OQ2). Only persist when an assignment on this input
      //    already exists — the operator assigns the WHIP source to the input.
      const guestAssignment = production.sources.find((s) => s.mixerInput === mixerInput);
      const returnMode = guestAssignment?.returnFeed?.synced ?? 'program-minus';
      if (guestAssignment && !guestAssignment.returnFeed) {
        try {
          await updateProductionDoc(invite.productionId, {
            sources: production.sources.map((s) =>
              s.mixerInput === mixerInput
                ? { ...s, returnFeed: { synced: 'program-minus', lowLatency: false } }
                : s,
            ),
          });
        } catch (err) {
          // Non-fatal: the guest can still join; the return is built on next activate.
          fastify.log.warn({ err }, 'POST guests/:id/join — return-feed persist failed');
        }
      }

      // 5b. Provision an Open Intercom talkback line (audio only, OQ1). Degrades
      //    cleanly: when the intercom vars are unset this is silently skipped and
      //    join succeeds with `intercomLine` absent. When the vars ARE set the
      //    talkback line is explicitly enabled, so a failure to reach the manager
      //    is a 502 — an operator asked for talkback and it could not be
      //    delivered (spec §Configuration, §"Error codes").
      let intercomLine: IntercomLine | undefined;
      if (isIntercomEnabled()) {
        try {
          intercomLine = await provisionGuestLine({
            intercomProductionId: production.intercomProductionId,
            productionId: production._id,
            lineName: invite.label ?? mixerInput,
          });
        } catch (err) {
          if (err instanceof IntercomManagerError) {
            fastify.log.warn({ err }, 'POST guests/:id/join — intercom-manager unreachable');
            return reply.status(502).send({ error: 'Intercom manager unreachable', statusCode: 502 });
          }
          throw err;
        }

        // Record the intercom refs on the session and (first time only) on the
        // production so lines tear down with the production lifecycle. The
        // production write goes through updateProductionDoc (get-modify-put with
        // 409 retry) so it composes with the return-feed persist above instead of
        // clobbering it with a stale revision.
        try {
          session = { ...session, intercomLineId: intercomLine.id, updatedAt: new Date().toISOString() };
          await getGuestSessionsDb().insert(session);
          if (production.intercomProductionId !== intercomLine.productionId) {
            await updateProductionDoc(production._id, {
              intercomProductionId: intercomLine.productionId,
            });
          }
        } catch (err) {
          fastify.log.warn({ err }, 'POST guests/:id/join — intercom ref persist failed');
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
      }

      // 5c. Announce the guest to controller subscribers (issue #301). Broadcast
      //     the final persisted session (state `joined`, intercom ref if any).
      broadcastGuestState(session, invite.label);

      // 6. Build the response. whipUrl reuses the EXISTING WHIP proxy contract
      //    (`/api/v1/productions/:id/whip/:mixerInput`) — never a new WHIP path.
      //    The return picture feed URL is server-issued and scoped to this input;
      //    it is only live once the production is active (spec §"Return feeds").
      const base = resolvePublicBaseUrl(req);
      const whipUrl = `${base}/api/v1/productions/${invite.productionId}/whip/${encodeURIComponent(mixerInput)}`;
      const returnLive =
        production.status === 'active' &&
        !!production.stromFlowId &&
        (production.returnWhepUrls ?? []).some((r) => r.mixerInput === mixerInput);
      const feeds = returnLive
        ? [{
            id: 'picture',
            url: `${base}/api/v1/productions/${invite.productionId}/returns/${encodeURIComponent(mixerInput)}/picture/whep`,
            video: true,
          }]
        : [];
      return reply.status(200).send({
        guestId: session._id,
        whipUrl,
        feeds,
        modes: returnModesFor(mixerInput),
        defaultMode: 'program-minus',
        returnMode,
        // intercomLine absent when intercom is unconfigured — join still works with
        // WHIP video + WHEP return, no talkback (fallback is first-class — spec §Configuration).
        ...(intercomLine ? { intercomLine } : {}),
      });
    },
  );

  // Guest leaves (token-authed). Marks their session `left`.
  fastify.delete<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
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

      try {
        const existing = await getGuestSessionsDb().find({
          selector: { type: 'guest-session', inviteId: invite._id },
        });
        const live = (Array.isArray(existing?.docs) ? existing.docs : []).find(
          (s) => s.state !== 'left',
        );
        if (live) {
          const leftSession: GuestSessionDoc = {
            ...live,
            state: 'left',
            updatedAt: new Date().toISOString(),
          };
          await getGuestSessionsDb().insert(leftSession);
          broadcastGuestState(leftSession, invite.label);
        }
      } catch (err) {
        fastify.log.warn({ err }, 'DELETE guests/:id/session — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Guest management (operator / automation, API_KEY gated)
  // -------------------------------------------------------------------------

  // List live guest sessions for a production.
  fastify.get<{ Params: { id: string } }>(
    '/api/v1/productions/:id/guests',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      try {
        await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const db = getGuestSessionsDb();
      let result: Awaited<ReturnType<typeof db.find>>;
      try {
        result = await db.find({
          selector: { type: 'guest-session', productionId: req.params.id },
        });
      } catch (err) {
        fastify.log.warn({ err }, 'GET guests — DB query failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(sessionToApi));
    },
  );

  // Kick a guest (operator). Marks the session `left`; the guest's WHIP teardown
  // rides the existing WHIP DELETE contract.
  fastify.delete<{ Params: { id: string; guestId: string } }>(
    '/api/v1/productions/:id/guests/:guestId',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      let session: GuestSessionDoc;
      try {
        session = await getGuestSessionsDb().get(req.params.guestId);
      } catch {
        return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
      }
      if (session.productionId !== req.params.id) {
        return reply.status(403).send({ error: 'Guest is in a different production', statusCode: 403 });
      }
      try {
        const leftSession: GuestSessionDoc = {
          ...session,
          state: 'left',
          updatedAt: new Date().toISOString(),
        };
        await getGuestSessionsDb().insert(leftSession);
        broadcastGuestState(leftSession);
      } catch (err) {
        fastify.log.warn({ err }, 'DELETE guests/:guestId — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.status(204).send();
    },
  );
};

/**
 * Pick a mixer input for a guest whose invite did not pin one: the lowest
 * `video_in_N` not already taken by a source assignment. Falls back to
 * `video_in_0` when the production has no assignments. This is a placeholder
 * allocation — full capacity/allocation policy is a later sub-issue (OQ5).
 */
function allocateMixerInput(production: ProductionDoc): string {
  const taken = new Set((production.sources ?? []).map((s) => s.mixerInput));
  for (let i = 0; i < 64; i++) {
    const candidate = `video_in_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return 'video_in_0';
}

export default guestsRoutes;
