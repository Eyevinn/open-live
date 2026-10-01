/**
 * Guest-token scoping for the WHIP upload and return-picture WHEP routes
 * (issue #380, epic #208).
 *
 * A guest invite token (`olgi_v1_...`, `guest-invite-token.ts`) already lets a
 * guest browser call the token-authed join/leave routes in `guests.ts`. This
 * module extends the SAME identity + authorization checks to the WHIP
 * (`whip.ts`) and return-picture WHEP (`returns.ts`) routes, which sit behind
 * the shared `API_KEY` gate in `server.ts` and, until now, had no path for a
 * guest's per-invite token at all.
 *
 * `resolveGuestScope` is the single place that re-derives guest identity and
 * checks it is scoped to the requested `(productionId, mixerInput)` resource —
 * called from server.ts's shared-key onRequest gate (see the ARCHITECTURE note
 * there) so there is exactly one choke point for both crew (API_KEY) and guest
 * (invite token) callers, and a non-guest, non-API-key caller always falls
 * through to the existing default-401 behaviour.
 *
 * Error taxonomy (issue #380 acceptance criteria):
 *   401 — who-you-are failures: bad/forged/expired token signature, revoked
 *         invite (doc deleted or hash mismatch), persisted invite expiry, and
 *         a kicked/left guest (no live session for the invite).
 *   403 — not-your-resource failures: valid, live guest hitting a production
 *         or mixerInput that is not their own.
 *   404 / 409 — production gone / production ended, mirroring the join route.
 */

import { getDb, getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc } from '../db/types.js';
import {
  verifyGuestInviteToken,
  hashGuestInviteToken,
  GUEST_INVITE_TOKEN_PREFIX,
} from './guest-invite-token.js';
import { getGuestSigningKey } from './guest-signing-key.js';

/** True if `value` has the guest-invite-token prefix (`olgi_v1_`). Cheap pre-filter — does not verify the signature. */
export function looksLikeGuestToken(value: string): boolean {
  return value.startsWith(GUEST_INVITE_TOKEN_PREFIX);
}

// The two route families a guest invite token may authenticate (issue #380).
// Deliberately narrow: matches ONLY the WHIP upload routes and the
// return-picture WHEP routes (including the DELETE .../picture/whep/:sessionId
// child) — never widen this to other `/api/v1/productions/:id/...` routes.
const WHIP_PATH_RE = /^\/api\/v1\/productions\/[^/]+\/whip\/[^/]+$/;
const RETURN_PICTURE_PATH_RE = /^\/api\/v1\/productions\/[^/]+\/returns\/[^/]+\/picture\/whep(?:\/[^/]+)?$/;

/** True if `path` is one of the two guest-eligible WHIP/return-picture route families. */
export function isGuestEligibleWhipReturnPath(path: string): boolean {
  return WHIP_PATH_RE.test(path) || RETURN_PICTURE_PATH_RE.test(path);
}

/** The pieces a route handler needs once a guest caller has been scoped. */
export interface ResolvedGuestScope {
  invite: GuestInviteDoc;
  session: GuestSessionDoc;
  production: ProductionDoc;
}

export type GuestScopeResult =
  | ({ ok: true } & ResolvedGuestScope)
  | { ok: false; status: 401 | 403 | 404 | 409; error: string };

const INVALID_OR_EXPIRED = 'Invalid or expired invite';

/**
 * Resolves a guest invite bearer token into a scope, verifying it grants
 * access to `productionId` + `mixerInput`. Mirrors the identity checks in
 * `guests.ts`'s join/leave handlers (~lines 273-300) exactly — signature/exp,
 * doc lookup (revocation), tokenHash, persisted expiry — then adds the
 * resource-ownership checks join doesn't need: the invite's production, and
 * the guest's LIVE session's `mixerInput` (NOT `invite.mixerInput`, which is
 * optional and may predate an auto-allocation decided at join time — see the
 * module doc and the warning on `returns.ts`'s `PUT /guests/:inviteId/session/return`,
 * which scopes off `invite.mixerInput` and 404s for auto-allocated guests;
 * that narrower pattern must not be copied here).
 */
export async function resolveGuestScope(
  token: string,
  productionId: string,
  mixerInput: string,
): Promise<GuestScopeResult> {
  const secret = getGuestSigningKey();
  if (!secret) {
    // Guest calling is disabled — never attempt guest verification.
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }

  // 1. Verify signature + expiry cryptographically (no DB hit; timing-safe).
  const verified = verifyGuestInviteToken(token, secret);
  if (!verified.ok) {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }

  // 2. Load the invite doc and compare the stored hash. Revocation (DELETE)
  //    removes the doc even while the signature is still cryptographically
  //    valid, so both a missing doc and a hash mismatch read as 401.
  let invite: GuestInviteDoc;
  try {
    invite = await getGuestInvitesDb().get(verified.claims.inviteId);
  } catch {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }
  if (invite.tokenHash !== hashGuestInviteToken(token)) {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }
  // Belt-and-braces: the persisted expiry (independent of the token's own exp).
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }

  // 3. The guest must have a LIVE session (state !== 'left'). A guest who was
  //    kicked or has left reads as 401 (issue #380 acceptance criteria) — same
  //    bucket as a revoked/expired invite, not 403, even though it is
  //    conceptually closer to "not your resource".
  let session: GuestSessionDoc | undefined;
  try {
    const existing = await getGuestSessionsDb().find({
      selector: { type: 'guest-session', inviteId: invite._id },
    });
    session = (Array.isArray(existing?.docs) ? existing.docs : []).find(
      (s) => s.state !== 'left',
    );
  } catch {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }
  if (!session) {
    return { ok: false, status: 401, error: INVALID_OR_EXPIRED };
  }

  // 4. Authorization — the token/session is valid, but is it scoped to THIS
  //    resource? Wrong production or wrong mixerInput is 403 (not-your-resource).
  if (invite.productionId !== productionId) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  if (session.mixerInput !== mixerInput) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  // 5. The production must still be live for a guest caller — mirrors the
  //    join route's deactivate check (guests.ts ~line 314). Crew/API_KEY
  //    callers are not subject to this: they use the production lifecycle
  //    routes directly and this check only applies on the guest branch.
  let production: ProductionDoc;
  try {
    production = await getDb().get(productionId);
  } catch {
    return { ok: false, status: 404, error: 'Production not found' };
  }
  if (production.status === 'ended') {
    return { ok: false, status: 409, error: 'Production is not active' };
  }

  return { ok: true, invite, session, production };
}

/**
 * True if `sessionUrl`'s path is `expectedEndpointUrl`'s path, or a sub-path of
 * it (e.g. the WHIP resource URL Strom mints under an endpoint). Used to bind
 * a guest's WHIP PATCH/DELETE `?session=` target to their own scoped endpoint
 * instead of trusting the client-supplied URL outright — `assertSameStromOrigin`
 * alone only checks the URL is on the Strom host, not that it belongs to this
 * guest (issue #380, most serious gap: a guest could otherwise PATCH/DELETE
 * another guest's WHIP session by supplying its URL).
 */
export function isUnderEndpointPath(sessionUrl: string, expectedEndpointUrl: string): boolean {
  let session: URL;
  let expected: URL;
  try {
    session = new URL(sessionUrl);
    expected = new URL(expectedEndpointUrl);
  } catch {
    return false;
  }
  return (
    session.pathname === expected.pathname || session.pathname.startsWith(`${expected.pathname}/`)
  );
}
