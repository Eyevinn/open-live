import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
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
  ProductionSourceAssignment,
} from '../db/types.js';
import {
  generateGuestInviteToken,
  verifyGuestInviteToken,
  hashGuestInviteToken,
} from '../lib/guest-invite-token.js';
import { config, isGuestCallingEnabled } from '../config.js';
import { getGuestSigningKey } from '../lib/guest-signing-key.js';
import { broadcast } from '../services/tally.service.js';
import { resolvePublicBaseUrl, updateProductionDoc } from './productions.js';
import { applyReturnMode, isInputOnProgram } from '../ws/controller.js';
import { getStromToken } from '../lib/strom-token.js';
import { assertSameStromOrigin } from '../lib/url-validation.js';
import { resolveGuestSession, slotTakesWhip } from '../lib/guest-scope.js';
import {
  applyGuestSlotMixerLabel,
  guestSlotDefaultLabel,
  clearGuestSlotPicture,
  restoreGuestSlotPicture,
} from '../lib/guest-slot-label.js';
import { getIceServers } from '../lib/ice-servers.js';
import type { IceServer } from '../lib/strom.js';
import {
  isIntercomEnabled,
  guestLineName,
  provisionGuestLine,
  IntercomManagerError,
  type IntercomLine,
  postTalkbackOffer,
  deleteTalkbackSession,
  endTalkbackSession,
  talkbackUsername,
  isTalkbackSessionId,
  TALKBACK_SDP_MAX_BYTES,
  type TalkbackKind,
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
  /**
   * The guest slot this invite pins the guest to (#381 item 2). Required in
   * practice: an invite with no slot, or one whose input is not a declared guest
   * slot on the production, is rejected at create time (kept optional in the
   * schema so that rejection returns a clear, domain-specific 400 rather than a
   * generic zod error).
   */
  mixerInput: z.string().min(1).max(64).optional(),
});

/** Mic mute toggle reported by the guest page while live (issue #382). */
const MuteBody = z.object({ muted: z.boolean() });

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
  const { _id, _rev, type, whipSessionUrl, talkbackWhipSessionId, talkbackWhepSessionId, ...rest } = doc;
  void _rev;
  void type;
  void whipSessionUrl; // internal Strom session-resource URL — never echo to clients
  // Internal intercom-manager talkback session ids (issue #599) — never echo.
  void talkbackWhipSessionId;
  void talkbackWhepSessionId;
  // `muted` is always projected (default false) so the operator's guest list
  // reflects mute state even for a guest who has not toggled it yet (issue #382).
  return { id: _id, ...rest, muted: !!doc.muted };
}

/**
 * Broadcast a GUEST_STATE lifecycle event to a production's controller
 * subscribers (epic #208, issue #301). Emitted on the persisted transitions
 * (`joined` on join, `left` on leave/kick/revoke). previewing/on-air are derived on
 * the WS controller connect snapshot from the live tally, not re-derived here.
 */
function broadcastGuestState(session: GuestSessionDoc, label?: string): void {
  broadcast(session.productionId, {
    type: 'GUEST_STATE',
    guestId: session._id,
    mixerInput: session.mixerInput,
    state: session.state,
    // Always carry mute state so the operator UI (studio#163) can render the
    // muted badge from any GUEST_STATE, not only mute-change events (issue #382).
    muted: !!session.muted,
    ...(label ? { label } : {}),
    ...(session.intercomLineId ? { intercomLine: session.intercomLineId } : {}),
  });
}

/**
 * Broadcast `GUEST_STATE` `left` (no label) for a revoked invite's slot so every
 * operator client reverts the strip live — Studio's handler re-fetches `/audio`
 * on any GUEST_STATE, and `/audio` now resolves the slot to "Guest N" because
 * the invite is gone (issue #561). One event per live session of the invite
 * (`guestId` = session id, so Studio drops the right guest row); when the invite
 * had no live session, one event keyed by the invite id still carries the slot's
 * `mixerInput` so the strip refreshes. Skipped only when no slot is known (an
 * unpinned invite nobody redeemed). Never throws — the invite is already revoked.
 * Returns the invite's live sessions (empty when the lookup failed) so the
 * caller can tear down their talkback (issue #600).
 */
async function broadcastInviteRevoked(
  invite: GuestInviteDoc,
  log: FastifyBaseLogger,
): Promise<GuestSessionDoc[]> {
  let live: GuestSessionDoc[] = [];
  try {
    const result = await getGuestSessionsDb().find({
      selector: { type: 'guest-session', inviteId: invite._id },
    });
    live = (Array.isArray(result?.docs) ? result.docs : []).filter((s) => s.state !== 'left');
  } catch (err) {
    log.warn({ err }, 'DELETE guests/invites — guest-session lookup failed; broadcasting by invite');
  }
  if (live.length > 0) {
    for (const session of live) {
      broadcastGuestState({ ...session, state: 'left' });
    }
    return live;
  }
  if (!invite.mixerInput) return live;
  broadcast(invite.productionId, {
    type: 'GUEST_STATE',
    guestId: invite._id,
    mixerInput: invite.mixerInput,
    state: 'left',
    muted: false,
  });
  return live;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Extract a Bearer token from the Authorization header, if present. */
function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers['authorization'];
  return auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
}

/**
 * 503 when no guest-invite signing key is available. Guest calling is on by
 * default (issue #391) — the backend generates and stores a key on first start —
 * so this only fires if no key could be loaded at all (e.g. the DB was
 * unreachable at startup and no `GUEST_INVITE_SECRET` override is set).
 */
function guestsDisabled(): { error: string; statusCode: 503 } {
  return {
    error: 'Guest calling is temporarily unavailable — the invite signing key could not be loaded',
    statusCode: 503,
  };
}

/**
 * A guest slot (issue #381) is a mixer input reserved for guests: a source
 * assignment carrying a `returnFeed` (program-minus), declared before air and
 * built into the flow as a per-guest return bus at activation
 * (`assignReturnBuses`, `src/lib/flow-generator.ts`). Its presence is the single
 * determinant of "is this a guest slot" for invite-create and join validation —
 * the same `mixerInput` + `returnFeed` check the return routes already use
 * (`src/routes/returns.ts`). Returns the assignment, or undefined if the input
 * is not a declared guest slot on this production.
 */
function guestSlotAssignment(
  production: ProductionDoc,
  mixerInput: string | undefined,
): ProductionSourceAssignment | undefined {
  if (!mixerInput) return undefined;
  return (production.sources ?? []).find(
    (s) => s.mixerInput === mixerInput && !!s.returnFeed,
  );
}

/**
 * Free a guest slot on the server (issue #381 item 4): tear down the guest's
 * WHIP publisher in Strom from the backend, rather than leaving teardown to the
 * guest's browser, so a crashed or lingering browser cannot keep the slot busy
 * for the next guest.
 *
 * Strom only routes `DELETE` on the WHIP **session resource**
 * (`/whip/{endpoint_id}/resource/{resource_id}`), NOT on the bare endpoint — a
 * DELETE on the endpoint does nothing, so Strom kept the guest session until its
 * 10 s inactivity reaper (issue #467). We therefore DELETE the exact
 * session-resource URL Strom minted at publish time, captured from the WHIP POST
 * `Location` and persisted on the session as `whipSessionUrl`.
 *
 * No-op when the session never published a WHIP resource (return-only slot, or
 * the guest left before publishing) — there is nothing to tear down. Best-effort:
 * a failure must not block the kick/leave that frees the slot in our own state,
 * but — unlike before — the outcome is now LOGGED (non-2xx or network error) so a
 * lingering Strom session is diagnosable rather than silently swallowed.
 */
async function teardownGuestWhip(
  session: GuestSessionDoc,
  log: FastifyBaseLogger,
): Promise<void> {
  const target = session.whipSessionUrl;
  if (!target) return;
  // Defence in depth: only ever DELETE a URL on the configured Strom host, so a
  // malformed/forged stored Location can never drive an SSRF or leak the Strom
  // bearer token off-host (mirrors `assertSameStromOrigin` on the WHIP proxy).
  try {
    assertSameStromOrigin(target, config.stromUrl, 'WHIP session URL');
  } catch (err) {
    log.warn({ err, target }, 'guest WHIP teardown — stored session URL is not on the Strom host; skipping');
    return;
  }
  const token = await getStromToken(config.stromToken).catch(() => undefined);
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const res = await fetch(target, { method: 'DELETE', headers });
    if (!res.ok) {
      log.warn(
        { status: res.status, target },
        'guest WHIP teardown — Strom returned non-2xx; session may linger until the inactivity reaper',
      );
    }
  } catch (err) {
    log.warn(
      { err, target },
      'guest WHIP teardown — DELETE to Strom failed; session may linger until the inactivity reaper',
    );
  }
}

/**
 * End a guest's own talkback sessions on the intercom manager (guest-talkback
 * spec §6, issue #600) — used when a guest leaves, is kicked, or their invite is
 * revoked. DELETEs the manager WHIP/WHEP sessions stored in
 * `talkbackWhipSessionId` / `talkbackWhepSessionId` so the line frees straight
 * away instead of waiting for the manager's media-less-session reaper. The line
 * itself is NOT deleted: it belongs to the slot and is reused (§3.6).
 *
 * No-op when the session never opened talkback (no stored ids — also legacy
 * sessions), when intercom is unconfigured, or when nothing is provisioned. A
 * manager `404` counts as already gone. Never throws, same contract as
 * `teardownGuestWhip`: every outcome is logged and the triggering action
 * always succeeds.
 */
async function teardownGuestTalkback(
  session: GuestSessionDoc,
  log: FastifyBaseLogger,
): Promise<void> {
  const owned = TALKBACK_KINDS.flatMap((kind) => {
    const sessionId = session[talkbackField(kind)];
    return sessionId ? [{ kind, sessionId }] : [];
  });
  if (owned.length === 0 || !session.intercomLineId || !isIntercomEnabled()) return;
  const context = { guestId: session._id, productionId: session.productionId };
  let production: ProductionDoc | undefined;
  try {
    production = await loadTalkbackProduction(session.productionId);
  } catch (err) {
    log.warn({ ...context, err }, 'talkback teardown: production lookup failed; the manager reaper takes over');
    return;
  }
  const intercomProductionId = production?.intercomProductionId;
  if (!intercomProductionId) return;
  const lineId = session.intercomLineId;
  await Promise.all(
    owned.map(({ kind, sessionId }) =>
      endTalkbackSession({ kind, productionId: intercomProductionId, lineId, sessionId }, log, context),
    ),
  );
}

/**
 * Reset a guest slot on teardown — used when a guest leaves, is kicked, or their
 * invite is revoked. Loads the production fresh (the live flow/mixer ids and the
 * `mixerInputMap` live there) and best-effort:
 *   - resets the multiview tile back to its `Guest N` label (issue #466);
 *   - blacks the slot's picture so the dropped guest's last decoded frame no
 *     longer stays frozen on PGM / the multiview (issue #493).
 * Never throws: a failure must not block the leave/kick/revoke that frees the
 * slot (same contract as `teardownGuestWhip`). No-op when the production is gone
 * or the slot is not a declared guest slot.
 */
async function resetGuestSlot(
  productionId: string,
  mixerInput: string | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!mixerInput) return;
  let production: ProductionDoc;
  try {
    production = await getDb().get(productionId);
  } catch {
    return;
  }
  const defaultLabel = guestSlotDefaultLabel(production, mixerInput);
  await applyGuestSlotMixerLabel(production, mixerInput, defaultLabel, log);
  // The audio mixer strip is NOT reset with a live PATCH here: `ch{N}_label` is
  // not a live Strom property (issue #522), so the write was always refused.
  // `GET /audio` resolves the strip label from the active guest-session instead,
  // so once this guest's session is marked `left` the strip reverts to "Guest N"
  // on its own.
  await clearGuestSlotPicture(production, mixerInput, log);
}

// ---------------------------------------------------------------------------
// Talkback WHIP/WHEP proxy helpers (guest-talkback spec §3.2–§3.3, issue #599)
// ---------------------------------------------------------------------------

const TALKBACK_KINDS: readonly TalkbackKind[] = ['whip', 'whep'];

/** The session field binding a guest's talkback resource of `kind`. */
function talkbackField(kind: TalkbackKind): 'talkbackWhipSessionId' | 'talkbackWhepSessionId' {
  return kind === 'whip' ? 'talkbackWhipSessionId' : 'talkbackWhepSessionId';
}

/**
 * Checks the offer is an SDP body (spec §3.2: `application/sdp`, opaque,
 * ≤ 64 KiB — the size cap is the content-type parser's `bodyLimit`). Sends
 * `415` for another media type and `400` for an empty body. Returns the SDP,
 * or undefined once a reply has been sent.
 */
function talkbackOfferSdp(req: FastifyRequest, reply: FastifyReply): string | undefined {
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/sdp') {
    void reply.status(415).send({ error: 'Unsupported Media Type', statusCode: 415 });
    return undefined;
  }
  if (typeof req.body !== 'string' || !req.body.trim()) {
    void reply.status(400).send({ error: 'Malformed SDP', statusCode: 400 });
    return undefined;
  }
  return req.body;
}

/** Send a proxy error, with `Retry-After` when the manager rate-limited us. */
function sendTalkbackError(
  reply: FastifyReply,
  result: { status: number; error: string; retryAfter?: string },
): FastifyReply {
  if (result.retryAfter) reply.header('Retry-After', result.retryAfter);
  return reply.status(result.status).send({ error: result.error, statusCode: result.status });
}

/**
 * `201` with the SDP answer and an open-live `Location`. `ETag` is the session
 * id open-live exposes; the manager's raw `Location` and `Link` (ICE servers,
 * possibly TURN credentials) are never forwarded.
 */
function sendTalkbackAnswer(
  reply: FastifyReply,
  location: string,
  sessionId: string,
  answer: string,
): FastifyReply {
  reply.header('Location', location);
  reply.header('ETag', sessionId);
  reply.header('Content-Type', 'application/sdp');
  return reply.status(201).send(answer);
}

/**
 * The intercom production/line a guest session talks on, read from open-live's
 * own DB (spec §3.2, R4): `ProductionDoc.intercomProductionId` and the live
 * `GuestSessionDoc.intercomLineId`. Undefined when talkback is unavailable
 * (intercom unconfigured, nothing provisioned, or the production ended).
 */
function talkbackLine(
  production: ProductionDoc,
  session: GuestSessionDoc,
): { productionId: string; lineId: string } | undefined {
  if (!isIntercomEnabled() || production.status === 'ended') return undefined;
  if (!production.intercomProductionId || !session.intercomLineId) return undefined;
  return { productionId: production.intercomProductionId, lineId: session.intercomLineId };
}

/** Load a production for a talkback call; `undefined` = not found, throws on a DB failure. */
async function loadTalkbackProduction(productionId: string): Promise<ProductionDoc | undefined> {
  try {
    return await getDb().get(productionId);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return undefined;
    throw err;
  }
}

/**
 * Write (or clear, with `sessionId` undefined) a guest's talkback session id on
 * their session doc. One retry on a revision conflict, re-reading the doc.
 * Best-effort: a failure is logged and the guest fails closed on a later
 * DELETE (403) rather than the proxy trusting an unbound id.
 */
async function bindTalkbackSession(
  session: GuestSessionDoc,
  kind: TalkbackKind,
  sessionId: string | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const field = talkbackField(kind);
  const write = async (doc: GuestSessionDoc) => {
    const { [field]: _previous, ...rest } = doc;
    void _previous;
    await getGuestSessionsDb().insert({
      ...rest,
      ...(sessionId ? { [field]: sessionId } : {}),
      updatedAt: new Date().toISOString(),
    } as GuestSessionDoc);
  };
  try {
    await write(session);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 409) {
      log.warn({ err, kind }, 'talkback: guest session-id bind failed');
      return;
    }
    try {
      await write(await getGuestSessionsDb().get(session._id));
    } catch (retryErr) {
      log.warn({ err: retryErr, kind }, 'talkback: guest session-id bind failed after a conflict');
    }
  }
}

/** How long a guest join waits for Strom's ICE servers before going on without them. */
export const JOIN_ICE_SERVERS_TIMEOUT_MS = 3000;

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
      const secret = getGuestSigningKey()!;
      const body = CreateInviteBody.parse(req.body);

      // 404 if the production does not exist.
      let production: ProductionDoc;
      try {
        production = await getDb().get(req.params.id);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }

      // v1 (#381 item 2): an invite must target a pre-declared guest slot — a
      // source assignment carrying a `returnFeed`. The placeholder join-time
      // allocation (allocateMixerInput) is gone, so a guest can never be handed
      // an input the running flow does not have. Reject a missing slot or a
      // non-guest-slot input with a clear, actionable error.
      if (!body.mixerInput) {
        return reply.status(400).send({
          error:
            'A guest invite must target a guest slot: set mixerInput to a guest slot declared on this production',
          statusCode: 400,
        });
      }
      if (!guestSlotAssignment(production, body.mixerInput)) {
        return reply.status(400).send({
          error: `mixerInput '${body.mixerInput}' is not a guest slot on this production (a guest slot is a source assignment with a returnFeed)`,
          statusCode: 400,
        });
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
      // The guest opens this page (served by THIS backend — shares origin with
      // join/WHIP/returns, no CORS; issue #382). The token rides the URL fragment
      // (`#`) so it never reaches server or proxy access logs, unlike a query
      // string. The page reads it from `location.hash` and calls join itself.
      const joinUrl = `${base}/guest/${inviteId}#${token}`;
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
      // Reset the slot's multiview tile back to `Guest N` (issue #466) and black
      // its picture (issue #493): a revoked invite's guest should no longer be
      // named on air, nor leave a frozen last frame. Best-effort — the invite is
      // already revoked and the DELETE must not fail over a cosmetic label/picture.
      await resetGuestSlot(doc.productionId, doc.mixerInput, fastify.log);
      // Tell every connected controller the slot is free (issue #561). Without
      // this only the client that issued the DELETE re-fetched `/audio`; every
      // other operator kept the revoked guest's name on the audio strip.
      const live = await broadcastInviteRevoked(doc, fastify.log);
      // End each live session's talkback on the intercom manager (issue #600).
      // Best-effort and never throws — the invite is already revoked.
      await Promise.all(live.map((session) => teardownGuestTalkback(session, fastify.log)));
      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Guest join / session (token-authed — exempt from shared API_KEY in server.ts)
  // -------------------------------------------------------------------------

  // What the guest page needs before it asks for a camera: whether this slot
  // takes WHIP from the browser or is return-only. Read-only — creates no
  // session, so opening the link does not occupy the slot.
  fastify.get<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/slot',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = getGuestSigningKey()!;
      const token = bearerToken(req);
      const verified = token ? verifyGuestInviteToken(token, secret) : undefined;
      if (!verified?.ok || verified.claims.inviteId !== req.params.inviteId) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      let invite: GuestInviteDoc;
      try {
        invite = await getGuestInvitesDb().get(req.params.inviteId);
      } catch {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      if (invite.tokenHash !== hashGuestInviteToken(token!)) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      if (Date.parse(invite.expiresAt) <= Date.now()) {
        return reply.status(409).send({ error: 'Invite expired', statusCode: 409 });
      }
      let production: ProductionDoc;
      try {
        production = await getDb().get(invite.productionId);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      if (production.status === 'ended') {
        return reply.status(409).send({ error: 'Production is not active', statusCode: 409 });
      }
      const slot = guestSlotAssignment(production, invite.mixerInput);
      if (!slot) {
        return reply.status(409).send({
          error: 'Invite is not bound to an available guest slot',
          statusCode: 409,
        });
      }
      try {
        return reply.send({ mixerInput: slot.mixerInput, returnOnly: !(await slotTakesWhip(slot)) });
      } catch (err) {
        fastify.log.warn({ err }, 'GET guests/:id/slot — source lookup failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
    },
  );

  fastify.post<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/join',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = getGuestSigningKey()!;
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
      // 3b. Resolve the guest slot the invite is pinned to (#381 item 2). v1 has
      //     no allocation fallback: an invite with no slot, or one whose input is
      //     no longer a guest slot (returnFeed removed) on this production, cannot
      //     join. Invite-create already enforces this, so this is defence in depth
      //     against a slot removed between create and join.
      const slot = guestSlotAssignment(production, invite.mixerInput);
      if (!invite.mixerInput || !slot) {
        return reply.status(409).send({
          error: 'Invite is not bound to an available guest slot',
          statusCode: 409,
        });
      }
      const mixerInput = invite.mixerInput;
      // A slot whose source is not WHIP (an SRT encoder) is return-only: the
      // guest's picture and voice reach the slot another way.
      let takesWhip: boolean;
      try {
        takesWhip = await slotTakesWhip(slot);
      } catch (err) {
        fastify.log.warn({ err }, 'POST guests/:id/join — source lookup failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }

      // 4. Create (or reuse) the guest session, enforcing one guest per slot
      //    (#381 item 3):
      //      - a rejoin on THIS invite reuses its own non-`left` session, so a
      //        reconnect (network drop / page reload) keeps working as before;
      //      - another invite's live (non-`left`) session on the same slot means
      //        the slot is taken → 409 "Guest slot occupied".
      const now = new Date().toISOString();
      let session: GuestSessionDoc;
      let isNewOccupant = false;
      try {
        const existing = await getGuestSessionsDb().find({
          selector: { type: 'guest-session', productionId: invite.productionId },
        });
        const docs = Array.isArray(existing?.docs) ? existing.docs : [];
        const ownLive = docs.find(
          (s) => s.inviteId === invite._id && s.state !== 'left',
        );
        if (ownLive) {
          // A rejoin starts unmuted — the mute state resets (issue #382). The
          // intercom line ref is re-established by step 5b, so a rejoin whose
          // provisioning degrades does not keep a stale `intercomLineId` (#598).
          const { intercomLineId: _staleLine, ...rest } = ownLive;
          session = { ...rest, mixerInput, state: 'joined', muted: false, updatedAt: now };
        } else {
          const occupant = docs.find(
            (s) => s.mixerInput === mixerInput && s.inviteId !== invite._id && s.state !== 'left',
          );
          if (occupant) {
            return reply.status(409).send({ error: 'Guest slot occupied', statusCode: 409 });
          }
          isNewOccupant = true;
          session = {
            _id: `guest-session-${randomUUID()}`,
            type: 'guest-session',
            productionId: invite.productionId,
            inviteId: invite._id,
            mixerInput,
            state: 'joined',
            muted: false,
            createdAt: now,
            updatedAt: now,
          };
        }
        // Carry the new revision so the intercom-ref write below (step 5b) is an
        // update of this doc, not a conflicting second insert.
        const written = await getGuestSessionsDb().insert(session);
        if (written?.rev) session = { ...session, _rev: written.rev };
      } catch (err) {
        fastify.log.warn({ err }, 'POST guests/:id/join — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }

      // 5a. Fresh return per guest (#381 item 5): return mode is per-slot config,
      //     not carried-over state. A NEW occupant resets the slot to its default
      //     program-minus so it never inherits the previous guest's mode; a
      //     reconnect (same invite) keeps the slot's current mode. Uses the shared
      //     applyReturnMode entry point (persists on the assignment + returnBuses,
      //     applies the live send matrix when the flow is active, broadcasts
      //     RETURN_STATE) — the same path the crew/guest mode routes use.
      let returnMode: 'program' | 'program-minus' = slot.returnFeed!.synced;
      if (isNewOccupant && returnMode !== 'program-minus') {
        try {
          await applyReturnMode(invite.productionId, mixerInput, 'program-minus');
          returnMode = 'program-minus';
        } catch (err) {
          fastify.log.warn({ err }, 'POST guests/:id/join — return-mode reset failed');
        }
      }

      // 5b. Provision (or reuse) the slot's Open Intercom talkback line (audio
      //    only, OQ1; guest-talkback spec §3.6, issue #598). One line per guest
      //    slot, named `guest-<mixerInput>`, reused on rejoin and by the slot's
      //    next occupant. Degrades: when the intercom vars are unset this is
      //    skipped, and any IntercomManagerError (or a failure to record the
      //    refs) is logged at warn level — join still answers 200, just without
      //    `intercomLine`, and the session carries no `intercomLineId`. Join
      //    never fails because of intercom.
      let intercomLine: IntercomLine | undefined;
      if (isIntercomEnabled()) {
        try {
          intercomLine = await provisionGuestLine({
            intercomProductionId: production.intercomProductionId,
            productionId: production._id,
            lineName: guestLineName(mixerInput),
          });
        } catch (err) {
          if (!(err instanceof IntercomManagerError)) throw err;
          fastify.log.warn({ err }, 'POST guests/:id/join — intercom line provisioning failed; joining without talkback');
        }
      }
      if (intercomLine) {
        // Record the intercom refs on the production (first time only, so lines
        // tear down with the production lifecycle) and then on the session. The
        // production write goes through updateProductionDoc (get-modify-put with
        // 409 retry) so it composes with the return-feed persist above instead of
        // clobbering it with a stale revision.
        try {
          if (production.intercomProductionId !== intercomLine.productionId) {
            await updateProductionDoc(production._id, {
              intercomProductionId: intercomLine.productionId,
            });
          }
          const withLine: GuestSessionDoc = {
            ...session,
            intercomLineId: intercomLine.id,
            updatedAt: new Date().toISOString(),
          };
          const written = await getGuestSessionsDb().insert(withLine);
          session = written?.rev ? { ...withLine, _rev: written.rev } : withLine;
        } catch (err) {
          fastify.log.warn({ err }, 'POST guests/:id/join — intercom ref persist failed; joining without talkback');
          intercomLine = undefined;
        }
      }

      // 5c. Announce the guest to controller subscribers (issue #301). Broadcast
      //     the final persisted session (state `joined`, intercom ref if any).
      broadcastGuestState(session, invite.label);

      // 5d. Show the guest's invite name on their multiview tile while the show
      //     runs (issue #466). `input_{N}_label` became a live property in Strom
      //     PR#1014, so when the flow is live we PATCH the invite label onto the
      //     slot's tile (falling back to `Guest N` when the invite has no label).
      //     Best-effort: on an older Strom the property is rejected and the tile
      //     keeps `Guest N` — the join has already succeeded and must not fail.
      const joinedLabel = invite.label ?? guestSlotDefaultLabel(production, mixerInput);
      await applyGuestSlotMixerLabel(production, mixerInput, joinedLabel, fastify.log);
      // The slot's audio strip name is NOT pushed with a live PATCH (issues #497,
      // #522): `ch{N}_label` is not a live Strom property, so the write was always
      // refused and only logged noise. `GET /audio` instead resolves the strip
      // label from this active guest-session's invite name, so it shows on join and
      // survives a controller reload with no live write.
      // Restore the slot's picture to fully opaque (issue #493): a previous guest
      // leaving this slot blacked it (input alpha 0), so without this a rejoining
      // or next guest on the same live flow would stay invisible. Best-effort —
      // never fails the join; a Strom without the live alpha property just no-ops.
      await restoreGuestSlotPicture(production, mixerInput, fastify.log);

      // 6. Build the response. whipUrl and the return-picture feed URL point at
      //    the guest-scoped aliases under `/api/v1/guests/:inviteId/...` (issue
      //    #423) rather than the crew `/api/v1/productions/...` paths: on OSC the
      //    ingress gate only passes `^/api/v1/guests` (osaas-app#6143), so the
      //    guest page must reach WHIP/WHEP through its own invite-scoped routes.
      //    The crew paths are unchanged and still serve operator/automation
      //    callers. whipUrl is absent on a return-only slot. The return feed is
      //    only live once the production is active (spec §"Return feeds").
      const base = resolvePublicBaseUrl(req);
      const whipUrl = takesWhip ? `${base}/api/v1/guests/${req.params.inviteId}/whip` : undefined;
      const returnLive =
        production.status === 'active' &&
        !!production.stromFlowId &&
        (production.returnWhepUrls ?? []).some((r) => r.mixerInput === mixerInput);
      const feeds = returnLive
        ? [{
            id: 'picture',
            url: `${base}/api/v1/guests/${req.params.inviteId}/returns/picture/whep`,
            video: true,
          }]
        : [];
      // The page's ICE servers: Strom's list, so a guest off the network gets
      // the deployment's TURN server. Best effort, and bounded — without it
      // the page keeps its built-in STUN server.
      let iceServers: IceServer[] | undefined;
      try {
        let stale: Error | undefined;
        ({ iceServers, stale } = await getIceServers({ timeoutMs: JOIN_ICE_SERVERS_TIMEOUT_MS }));
        if (stale) {
          fastify.log.warn({ err: stale }, 'POST guests/:id/join — Strom unreachable, serving cached ICE servers');
        }
      } catch (err) {
        fastify.log.warn({ err }, 'POST guests/:id/join — ICE servers unavailable');
      }
      return reply.status(200).send({
        guestId: session._id,
        ...(whipUrl ? { whipUrl } : {}),
        returnOnly: !takesWhip,
        feeds,
        ...(iceServers?.length ? { iceServers } : {}),
        modes: returnModesFor(mixerInput),
        defaultMode: 'program-minus',
        returnMode,
        // intercomLine absent when intercom is unconfigured or provisioning failed —
        // join still works with WHIP video + WHEP return, no talkback (fallback is
        // first-class — spec §Configuration, guest-talkback spec §3.6).
        ...(intercomLine ? { intercomLine } : {}),
        // Server-issued talkback proxy URLs (guest-talkback spec §3.4, issue
        // #599): present exactly when a line was provisioned or reused. No
        // whipUrl on a return-only slot — the guest only listens (§4.1).
        ...(intercomLine
          ? {
              talkback: {
                ...(takesWhip ? { whipUrl: `${base}/api/v1/guests/${req.params.inviteId}/talkback/whip` } : {}),
                whepUrl: `${base}/api/v1/guests/${req.params.inviteId}/talkback/whep`,
              },
            }
          : {}),
      });
    },
  );

  // Guest leaves (token-authed). Marks their session `left`.
  fastify.delete<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = getGuestSigningKey()!;
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
          // Free the slot server-side (#381 item 4): end the guest's Strom WHIP
          // session so the next guest can take the slot even if this guest's
          // browser lingers or crashed (issue #467 — DELETE the session resource,
          // not the endpoint). teardownGuestWhip never throws, so it needs no
          // guard of its own.
          // Its talkback sessions are ended on the intercom manager next to it
          // (issue #600); neither throws.
          await Promise.all([
            teardownGuestWhip(leftSession, fastify.log),
            teardownGuestTalkback(leftSession, fastify.log),
          ]);
          // Reset the multiview tile back to `Guest N` (issue #466) and black the
          // slot's picture so the guest's last frame no longer stays frozen on
          // PGM / the multiview (issue #493). Best-effort — never fails the leave.
          await resetGuestSlot(leftSession.productionId, leftSession.mixerInput, fastify.log);
        }
      } catch (err) {
        fastify.log.warn({ err }, 'DELETE guests/:id/session — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.status(204).send();
    },
  );

  // Guest toggles their mic mute while live (token-authed, issue #382). The page
  // mutes locally by disabling the audio track (the WHIP session stays up); this
  // call only tells the backend so the operator sees it. Persists `muted` on the
  // live session and broadcasts an updated GUEST_STATE so the studio (studio#163)
  // reflects it within a second.
  fastify.put<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/mute',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const secret = getGuestSigningKey()!;
      const body = MuteBody.parse(req.body);
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
        // No live session to mute — the guest must join first (spec §"Error codes").
        if (!live) {
          return reply.status(404).send({ error: 'No active guest session', statusCode: 404 });
        }
        const updated: GuestSessionDoc = {
          ...live,
          muted: body.muted,
          updatedAt: new Date().toISOString(),
        };
        await getGuestSessionsDb().insert(updated);
        broadcastGuestState(updated, invite.label);
        return reply.send({ guestId: updated._id, muted: updated.muted });
      } catch (err) {
        fastify.log.warn({ err }, 'PUT guests/:id/session/mute — DB write failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
    },
  );

  // Guest reads whether they are on program (token-authed, issue #592). The
  // guest page polls this while live to show its ON AIR badge: it holds only the
  // invite token, never an operator WS connection, so it cannot see the tally.
  // The guest is untrusted, so the answer is the guest's OWN on-air boolean and
  // nothing else of the tally. Same identity check as `session/return`: the
  // invite's LIVE session, whose mixerInput is used (a left guest's token must
  // not read the state of whoever holds the slot now). A return-only slot (its
  // source is not WHIP) is never on air as the guest's picture: the guest only
  // receives the return there, so it always reads false.
  fastify.get<{ Params: { inviteId: string } }>(
    '/api/v1/guests/:inviteId/session/status',
    async (req, reply) => {
      if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
      const token = bearerToken(req);
      const who = token ? await resolveGuestSession(token) : undefined;
      if (!who?.ok || who.invite._id !== req.params.inviteId) {
        return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
      }
      const { invite, session } = who;
      let production: ProductionDoc;
      try {
        production = await getDb().get(invite.productionId);
      } catch {
        return reply.status(404).send({ error: 'Production not found', statusCode: 404 });
      }
      const slot = production.sources.find((s) => s.mixerInput === session.mixerInput);
      if (!session.mixerInput || !slot || production.status === 'ended') {
        return reply.send({ onAir: false });
      }
      let takesWhip: boolean;
      try {
        takesWhip = await slotTakesWhip(slot);
      } catch (err) {
        fastify.log.warn({ err }, 'GET guests/:id/session/status — source lookup failed');
        return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
      }
      return reply.send({
        onAir: takesWhip && isInputOnProgram(invite.productionId, session.mixerInput),
      });
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

  // Kick a guest (operator). Marks the session `left` AND tears down the guest's
  // WHIP publisher in Strom from the backend (#381 item 4) — not left to the
  // guest's browser — so a crashed or lingering browser cannot keep the slot busy
  // for the next guest.
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

      // Free the slot on the server so the next guest can join (#381 item 4):
      // end the guest's Strom WHIP session resource, not the endpoint (issue
      // #467). teardownGuestWhip never throws. `session` carries the stored
      // whipSessionUrl (leftSession is just the same doc marked `left`).
      // Its talkback sessions are ended on the intercom manager too (issue #600).
      await Promise.all([
        teardownGuestWhip(session, fastify.log),
        teardownGuestTalkback(session, fastify.log),
      ]);
      // Reset the multiview tile back to `Guest N` (issue #466) and black the
      // slot's picture so the kicked guest's last frame no longer stays frozen on
      // PGM / the multiview (issue #493). Best-effort — never fails the kick.
      await resetGuestSlot(session.productionId, session.mixerInput, fastify.log);

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // Talkback WHIP/WHEP proxy (guest-talkback spec §3.2–§3.3, ADR-012, issue
  // #599). open-live holds the manager's WHIP/WHEP Bearer and derives the
  // intercom production + line from its own DB; the client only supplies the
  // SDP. The guest routes are invite-token authed (exempt from API_KEY in
  // server.ts, UUID-constrained); the crew routes sit behind the default gate.
  // -------------------------------------------------------------------------

  // Opaque SDP offers, capped at the manager's 64 KiB (larger → 413).
  fastify.addContentTypeParser(
    'application/sdp',
    { parseAs: 'string', bodyLimit: TALKBACK_SDP_MAX_BYTES },
    (_req, body, done) => {
      done(null, body);
    },
  );

  for (const kind of TALKBACK_KINDS) {
    const field = talkbackField(kind);

    // Guest: publish (whip) into / listen (whep) to their own slot's line.
    fastify.post<{ Params: { inviteId: string } }>(
      `/api/v1/guests/:inviteId/talkback/${kind}`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
        const token = bearerToken(req);
        const who = token ? await resolveGuestSession(token) : undefined;
        if (!who?.ok || who.invite._id !== req.params.inviteId) {
          return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
        }
        const sdp = talkbackOfferSdp(req, reply);
        if (sdp === undefined) return reply;
        const { invite, session } = who;

        let production: ProductionDoc | undefined;
        try {
          production = await loadTalkbackProduction(invite.productionId);
        } catch (err) {
          req.log.warn({ err }, `POST guests/:id/talkback/${kind} — production lookup failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        if (!production) {
          return reply.status(404).send({ error: 'Talkback unavailable', statusCode: 404 });
        }
        // A return-only slot (SRT encoder) only listens (spec §4.1).
        if (kind === 'whip') {
          const slot = (production.sources ?? []).find((s) => s.mixerInput === session.mixerInput);
          let takesWhip = false;
          try {
            takesWhip = slot ? await slotTakesWhip(slot) : false;
          } catch (err) {
            req.log.warn({ err }, 'POST guests/:id/talkback/whip — source lookup failed');
            return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
          }
          if (!takesWhip) {
            return reply.status(403).send({ error: 'This guest slot does not take WHIP', statusCode: 403 });
          }
        }
        const line = talkbackLine(production, session);
        if (!line) {
          return reply.status(404).send({ error: 'Talkback unavailable', statusCode: 404 });
        }

        // The manager-side name is the invite label, never client-chosen.
        const username = talkbackUsername(
          invite.label,
          guestSlotDefaultLabel(production, session.mixerInput) ?? 'Guest',
        );
        const result = await postTalkbackOffer({ kind, ...line, username, sdp, log: req.log });
        if (!result.ok) return sendTalkbackError(reply, result);

        // Bind the new manager session to this guest, then end the one it
        // replaces so a rejoin never leaves two of the guest's sessions on the line.
        const previous = session[field];
        await bindTalkbackSession(session, kind, result.sessionId, req.log);
        if (previous && previous !== result.sessionId) {
          const ended = await deleteTalkbackSession({ kind, ...line, sessionId: previous, log: req.log });
          if (!ended.ok) {
            req.log.warn({ kind, status: ended.status }, 'talkback: could not end the replaced guest session');
          }
        }
        return sendTalkbackAnswer(
          reply,
          `/api/v1/guests/${encodeURIComponent(req.params.inviteId)}/talkback/${kind}/${result.sessionId}`,
          result.sessionId,
          result.answer,
        );
      },
    );

    // Guest: end their own talkback session.
    fastify.delete<{ Params: { inviteId: string; sessionId: string } }>(
      `/api/v1/guests/:inviteId/talkback/${kind}/:sessionId`,
      async (req, reply) => {
        if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
        const token = bearerToken(req);
        const who = token ? await resolveGuestSession(token) : undefined;
        if (!who?.ok || who.invite._id !== req.params.inviteId) {
          return reply.status(401).send({ error: 'Invalid or expired invite', statusCode: 401 });
        }
        const { sessionId } = req.params;
        if (!isTalkbackSessionId(sessionId)) {
          return reply.status(400).send({ error: 'Invalid session id', statusCode: 400 });
        }
        const { invite, session } = who;
        // R5: only the session bound to THIS guest, never a caller-chosen id.
        if (session[field] !== sessionId) {
          return reply.status(403).send({ error: 'Session does not belong to this guest', statusCode: 403 });
        }
        let production: ProductionDoc | undefined;
        try {
          production = await loadTalkbackProduction(invite.productionId);
        } catch (err) {
          req.log.warn({ err }, `DELETE guests/:id/talkback/${kind} — production lookup failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        const line = production ? talkbackLine(production, session) : undefined;
        if (line) {
          const result = await deleteTalkbackSession({ kind, ...line, sessionId, log: req.log });
          if (!result.ok) return sendTalkbackError(reply, result);
        }
        await bindTalkbackSession(session, kind, undefined, req.log);
        return reply.status(204).send();
      },
    );

    // Crew (Studio): talk to / listen to a guest's line. Not persisted —
    // Studio owns these sessions; crew is trusted at production scope.
    fastify.post<{ Params: { id: string; guestId: string }; Querystring: { name?: unknown } }>(
      `/api/v1/productions/:id/guests/:guestId/talkback/${kind}`,
      { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
      async (req, reply) => {
        if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
        let session: GuestSessionDoc;
        try {
          session = await getGuestSessionsDb().get(req.params.guestId);
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode === 404) {
            return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
          }
          req.log.warn({ err }, `POST guests/:guestId/talkback/${kind} — DB read failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        if (session.productionId !== req.params.id || session.state === 'left') {
          return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
        }
        const sdp = talkbackOfferSdp(req, reply);
        if (sdp === undefined) return reply;
        let production: ProductionDoc | undefined;
        try {
          production = await loadTalkbackProduction(req.params.id);
        } catch (err) {
          req.log.warn({ err }, `POST guests/:guestId/talkback/${kind} — production lookup failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        if (!production) {
          return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
        }
        const line = talkbackLine(production, session);
        if (!line) {
          return reply.status(404).send({ error: 'Talkback unavailable', statusCode: 404 });
        }
        const name = typeof req.query.name === 'string' ? req.query.name : undefined;
        const username = talkbackUsername(name, 'Producer');
        const result = await postTalkbackOffer({ kind, ...line, username, sdp, log: req.log });
        if (!result.ok) return sendTalkbackError(reply, result);
        return sendTalkbackAnswer(
          reply,
          `/api/v1/productions/${encodeURIComponent(req.params.id)}/guests/` +
            `${encodeURIComponent(req.params.guestId)}/talkback/${kind}/${result.sessionId}`,
          result.sessionId,
          result.answer,
        );
      },
    );

    // Crew: end a talkback session on the guest's line. Works after the guest
    // left (Studio tears down on GUEST_STATE left); nothing to do → 204.
    fastify.delete<{ Params: { id: string; guestId: string; sessionId: string } }>(
      `/api/v1/productions/:id/guests/:guestId/talkback/${kind}/:sessionId`,
      async (req, reply) => {
        if (!isGuestCallingEnabled()) return reply.status(503).send(guestsDisabled());
        const { sessionId } = req.params;
        if (!isTalkbackSessionId(sessionId)) {
          return reply.status(400).send({ error: 'Invalid session id', statusCode: 400 });
        }
        let session: GuestSessionDoc;
        let production: ProductionDoc | undefined;
        try {
          session = await getGuestSessionsDb().get(req.params.guestId);
        } catch (err) {
          if ((err as { statusCode?: number }).statusCode === 404) {
            return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
          }
          req.log.warn({ err }, `DELETE guests/:guestId/talkback/${kind} — DB read failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        if (session.productionId !== req.params.id) {
          return reply.status(404).send({ error: 'Guest not found', statusCode: 404 });
        }
        try {
          production = await loadTalkbackProduction(req.params.id);
        } catch (err) {
          req.log.warn({ err }, `DELETE guests/:guestId/talkback/${kind} — production lookup failed`);
          return reply.status(503).send({ error: 'Database unavailable', statusCode: 503 });
        }
        const line = production ? talkbackLine(production, session) : undefined;
        if (line) {
          const result = await deleteTalkbackSession({ kind, ...line, sessionId, log: req.log });
          if (!result.ok) return sendTalkbackError(reply, result);
        }
        return reply.status(204).send();
      },
    );
  }
};

export default guestsRoutes;
