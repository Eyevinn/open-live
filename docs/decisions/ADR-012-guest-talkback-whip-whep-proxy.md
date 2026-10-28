# ADR-012: Guest talkback uses intercom-manager's per-line WHIP/WHEP behind an open-live token-scoped proxy

**Date**: 2026-10-28
**Status**: Proposed

> Companion spec: [`docs/specs/guest-talkback.md`](../specs/guest-talkback.md), an addendum to
> [`docs/specs/guest-calling-intercom.md`](../specs/guest-calling-intercom.md).
> Issue: [Eyevinn/open-live#593](https://github.com/Eyevinn/open-live/issues/593).

## Context

Guest join already provisions an Open Intercom (intercom-manager) line per guest, but no client
joins it. Two parties have to reach that line: an **untrusted guest browser**, holding only a
per-invite token, and the **operator in Studio**, holding crew credentials. Constraints, verified
in intercom-manager source (v4.1.0 `6a977b8d`, v3.5.3 `3b6fa09b`):

- intercom-manager offers two ways for a client to join a line:
  1. **Session API** (what intercom-frontend uses). `POST /api/v1/session` makes the server
     offer, `PATCH /api/v1/session/:id` returns the answer, and `GET /heartbeat/:sessionId` must be
     called repeatedly or the session expires after about 100 s. On v4.1.0 these routes are guarded
     by `API_KEY` (`preHandler: requireApiKey`).
  2. **Per-line WHIP/WHEP.** `POST /whip|whep/:productionId/:lineId/:username` is client-offer,
     standard WHIP/WHEP with `Location` teardown. There is no heartbeat, and sessions with no media
     are reaped. `PATCH` (trickle) is a 405 stub, so ICE must be gathered before the POST.
- Both are guarded by **one deployment-wide secret**: `API_KEY` for the session API and
  `WHIP_AUTH_KEY` for WHIP/WHEP. intercom-manager has **no line-scoped or short-lived
  credential**. Anyone holding the key can publish into, or listen to, any line of any production.
- The OSC ingress only passes `^/guest` and `^/api/v1/guests` for guest traffic
  (osaas-app#6143). open-live already proxies guest WHIP and return WHEP under
  `/api/v1/guests/:inviteId/...` and derives targets server-side from the guest's live session
  (issue #423).
- Standing CTO rule: no new client library without a written reason.

## Decision

1. **Protocol: WHIP (send) + WHEP (receive) per line.** Each talkback participant uses two
   audio-only PeerConnections with non-trickle ICE. The session API is not used.
2. **Auth: open-live proxies every talkback signalling call.** Guests use
   `/api/v1/guests/:inviteId/talkback/{whip,whep}[/:sessionId]` (invite token). Studio uses
   `/api/v1/productions/:id/guests/:guestId/talkback/{whip,whep}[/:sessionId]` (API_KEY).
   open-live derives `productionId`/`lineId` from its own DB (`GuestSessionDoc.intercomLineId`,
   `ProductionDoc.intercomProductionId`), sets `Authorization: Bearer <INTERCOM_WHIP_AUTH_KEY>`
   on the outbound call, rewrites `Location`, and drops `Link`. Only signalling is proxied.
   Media flows directly between browser and SMB.
3. **Operator path: embedded in Studio** (GuestPanel), not an intercom-frontend share link.
4. **One line per guest slot**, reused across rejoins and occupants. Removed with the intercom
   production at deactivate.

## Consequences

**Positive**:
- The manager key never reaches a browser. A guest can only reach their own line while their
  invite and live session are valid. Kick, leave and revoke cut access on the next request
  (`resolveGuestSession` → 401) and server-side teardown ends the media.
- Same scoping model and code shape as the existing guest WHIP/return proxies. The guest page
  already has a non-trickle WHIP/WHEP client, and Studio has `src/lib/whep.ts`, so **no new
  dependency** in any repo.
- WHIP/WHEP needs no heartbeat loop and has standard `Location` teardown, and a crashed client is
  reaped by the manager. That suits a server-held lifecycle (leave/kick/revoke/deactivate).
- Works on both OSC `stable` (v3.5.3) and `beta` (v4.1.0) intercom-manager images.

**Negative**:
- Two PeerConnections per participant instead of one. The cost is two ICE/DTLS handshakes and
  two SMB endpoints per participant.
- Non-trickle ICE adds connection setup time (the guest page caps gathering at 2 s, or 6 s with
  TURN). Studio connects ahead of the first Talk press to hide it.
- open-live is now on the signalling path for talkback, so a slow open-live delays talkback setup
  (not media).
- Requires a fix to today's provisioning, which does not work against the real manager response
  shape (spec §1.1).

**Risks**:
- intercom-manager's 10/min POST rate limit is per peer IP with no `trustProxy`, so it is shared
  by every participant behind open-live. Detect: `talkback … 429` warnings. Mitigation:
  `503 + Retry-After` and one client retry. Open an upstream issue if beta verification hits it.
- On OSC the service may be gated by a Service Access Token in the same `Authorization` header
  WHIP auth uses (spec OQ3). Detect: the probe in sub-issue OL-A. Mitigation:
  `INTERCOM_MANAGER_AUTH_MODE=osc` sends the SAT and leaves `whipAuthKey` unset.
- Acoustic echo of talkback into the guest's program mic. Detect: tone test on beta.
  Mitigation: explicit echo cancellation, headphones hint, operator push-to-talk.

## Alternatives Considered

- **Hand the guest the manager key or a direct manager URL.** Rejected. The key is
  deployment-wide (any line, any production, publish and listen), cannot be revoked per invite,
  and would also expose the manager's TURN credentials via `Link`.
- **Session API (`POST /session` + `PATCH /session/:id`) behind the same proxy.** Rejected. It is
  server-offer, so the proxy would have to manage a two-step exchange. It needs a heartbeat every
  few seconds from each client, which means a guest-token heartbeat route and keeping sessions
  alive through open-live. It is guarded by the management `API_KEY`, so open-live would be
  proxying management-level calls. It is also intercom-frontend's internal protocol rather than a
  standard.
- **Add line-scoped credentials to intercom-manager** (signed short-lived per-line tokens).
  This is the cleanest long-term approach, but it gates #593 on an upstream change in a
  dependency, and both OSC images in use would need it. It can replace the proxy later without
  changing the client contract, because clients only see open-live URLs.
- **Operator via an intercom-frontend share link.** Rejected. It takes the operator out of
  Studio, needs `POST /share` plus OSC token config open-live does not have, has its own login,
  and knows nothing about guest lifecycle, so it cannot tear down on kick or leave.
- **Shared "guests" line or one line per guest session.** Rejected. A shared line leaks one
  guest's off-air talk to the others. Per-session lines need line deletion, which the manager
  refuses while participants are present (`400 Cannot remove a line with active participants`).
