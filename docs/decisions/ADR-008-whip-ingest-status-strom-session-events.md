# ADR-008: Full WHIP ingest status via Strom session events

**Date**: 2026-10-16
**Status**: Proposed — BLOCKED on an upstream Strom dependency (see `docs/specs/whip-ingest-status.md` §6, OQ-1). Requires human / product sign-off before Accepted.

## Context

`open-live` surfaces a per-source live WHIP ingest state (`connected` / `disconnected`) so an
operator can see which remote publishers are actually sending. The shipped interim (#439,
`src/services/whip-ingest-state.ts`) derives this **only** from `open-live`'s own WHIP signaling
proxy: offer POST → `connected`, session DELETE → `disconnected` (`src/routes/whip.ts:175,216`).

The proxy is blind to any session that does not round-trip it: a closed tab, a network drop, a
crash, or — critically — a session **Strom itself reaps** on ICE failure or its ~10 s inactivity
timeout (repo-patterns.md §"Strom ends a WHIP publish only on the session RESOURCE…"). None of
those send a DELETE, so the source is stuck reading `connected` forever. The proxy-only approach
also fundamentally cannot observe a *stall* (media flowing, then stopping, without the session
ending).

Constraints:

- The authoritative lifecycle of a WHIP session lives **inside Strom**, an external, NON-board
  repository (`Eyevinn/strom`). `open-live` can only observe what Strom exposes.
- Strom already runs a flow-event WebSocket at `/api/ws` that `open-live` consumes for meters,
  loudness, clip player state, and pipeline errors (`src/lib/strom.ts:681-722,1170-1194`), with an
  established one-WS-per-production, ref-counted, auto-reconnecting relay pattern
  (`src/services/meter-relay.ts`, `src/services/clip-relay.ts`).
- A prior health-signal decision (`docs/specs/production-lifecycle-health.md:122-134`) deliberately
  **omitted** a middle `degraded` value because no code-verified source existed for it — setting
  the bar that a new intermediate state (`stalled`) needs a real upstream signal behind it.
- **Strom does not emit a WHIP session event today.** This is the crux: the decision commits
  `open-live` to a contract that upstream Strom must implement first.

## Decision

1. **Key the robust WHIP ingest status off a new upstream Strom WHIP session event**, delivered on
   Strom's existing `/api/ws` flow-event socket using the same `{ "type", "data" }` envelope as
   every current variant — rather than any `open-live`-side heuristic (e.g. polling WHEP stream
   listings, RTP-stats scraping, or timers on the proxy). Strom is the only component that knows
   when it starts, stalls, resumes, or reaps a session, so it is the only correct source.

2. **Require the event to carry `endpoint_id`** (the `whip-{padIndex}-{endpointSuffix}` id
   `open-live` already mints in `resolveStromWhipUrl`, `src/routes/whip.ts:92-97`) and to fire on
   **Strom-internal cleanup** (ICE failure, idle reaper), not only on client/proxy DELETE — that is
   what makes it "robust" over #439. Request an optional `flow_id` so `open-live` can disambiguate
   the pre-existing truncated-endpoint-id collision (spec OQ-3) by the owning flow, exactly as the
   meter/clip relays already filter on `flow_id`.

3. **Introduce a third ingest state `stalled`** (`connected` | `stalled` | `disconnected`),
   widening the existing in-memory registry, the `liveIngest` REST field, and the
   `SOURCE_INGEST_STATE` WS message additively — **but only ship `stalled` once Strom actually emits
   a stall edge**, honouring the lifecycle-health precedent that an intermediate state must have a
   verified source.

4. **Consume the event in a dedicated instance-wide Strom WS subscription** (spec §4 option B),
   running for the process lifetime independent of controller connections, rather than piggy-backing
   on the controller-scoped meter/clip relay (option A). Rationale: the events most worth catching
   (idle-reaped / ICE-failed sessions) can occur with no controller connected, so a
   controller-scoped relay would miss them and leave the REST `liveIngest` field stale for a later
   reconnecting client. The cost is one always-on Strom WS with its own reconnect/backoff.

5. **Reuse every existing surface unchanged** except the widened enum: the registry module
   (`src/services/whip-ingest-state.ts`), the `toApi()` `liveIngest` projection
   (`src/routes/sources.ts:286-289`), the `broadcast()` of `SOURCE_INGEST_STATE`, and the
   connect-snapshot replay (`src/ws/controller.ts:3561-3573`).

This ADR is **Proposed** and gated: it cannot move to Accepted until the Strom event contract is
defined/confirmed and merged upstream, with product sign-off (spec OQ-1).

## Consequences

**Positive**
- Catches every way a publisher goes away, including the ones #439 structurally cannot (silent
  drops, ICE failure, Strom's own idle reaper), so the operator no longer sees frozen "connected"
  guests.
- Adds a genuine `stalled` signal backed by a real upstream edge.
- Reuses the proven Strom-WS relay machinery and all existing API surfaces; the client-visible
  change is one additive enum value (ignorable by old clients).
- Strom remains the single source of truth for session lifecycle, matching how clip player state
  is already handled (`src/services/clip-relay.ts`).

**Negative**
- Hard dependency on an external, non-board repo (`Eyevinn/strom`) that must ship the event first —
  `open-live` cannot complete or validate this alone. The epic is blocked until then.
- An instance-wide subscription (decision 4) is a new always-on Strom connection with its own
  lifecycle to maintain, distinct from the ref-counted per-production relays.
- Field names/shape in the spec are provisional until reconciled with Strom's real
  `types/src/events.rs` (same caveat the `PipelineError` consumer carries today).

**Risks**
- *Partial upstream implementation* (end fires, stall does not): detect by exercising a stall
  scenario on staging; degrade to #439-equivalent for the missing edges — do not ship `stalled`
  until observed.
- *Endpoint-id collision mis-route* (spec OQ-3): detect by asserting `flow_id` matches the resolved
  production's flow; mitigate by filtering on `flow_id` and/or lengthening the suffix upstream.
- *Relay socket leak / staleness*: detect via the Strom-WS reconnect logging already used by the
  meter relay; the instance-wide model needs a single supervised reconnect loop.

## Alternatives Considered

- **Poll Strom for active WHIP sessions** (e.g. a `/api/whip-streams` analogue to the existing
  `whep.listStreams()`, `src/lib/strom.ts:1159`). Rejected: Strom exposes no WHIP-ingest listing
  today (would itself need upstream work), and polling adds latency and load while still not
  distinguishing a stall from a healthy feed. An event is strictly better and uses a socket we
  already hold.
- **Scrape `webrtc-stats` / `rtp-stats`** (`src/lib/strom.ts:946-947`) and infer liveness from
  bitrate. Rejected: unstructured `Record<string, unknown>` (the same reason output `degraded` was
  not derivable, production-lifecycle-health.md:116-122), per-session attribution is unclear, and
  it is a fragile heuristic, not a lifecycle truth.
- **Keep the proxy-only #439 approach and add client-side timeouts.** Rejected: a timer in
  `open-live` or Studio cannot tell "slow but alive" from "gone", reintroducing exactly the
  false-state problem; and it still never sees Strom-reaped sessions.
- **Extend the controller-scoped meter/clip relay (spec §4 option A)** instead of an instance-wide
  subscription. Rejected as the primary design because it misses events that occur with no
  controller connected (the idle-reaper case), though it remains the cheaper fallback if an
  always-on socket is deemed unacceptable (spec OQ-6).
