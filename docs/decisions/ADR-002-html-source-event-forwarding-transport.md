# ADR-002: HTML-source event forwarding rides the controller WebSocket

**Date**: 2026-09-15
**Status**: Proposed

## Context

The OL-3 build decision (#187, resolved **Build** by @svensson00) asks for a thin, generic surface
that forwards operator events (from Bitfocus Companion and the Studio UI) into an HTML source, with
URL-parameter re-load control as the minimum first slice. The design lives in
`docs/specs/html-source-event-forwarding.md` (issue #268).

An HTML source already exists in the product: `streamType: 'html'` with a browser-URL `address`
(`src/db/types.ts:27-44`, `src/routes/sources.ts:15,20-26`), rendered to the mixer as a `cefsrc`
element (`src/lib/flow-generator.ts:525-545`). What is missing is any way for an operator to send an
event to that live page.

Two placement questions must be decided before implementation:

1. **Where does the operator event enter Open Live** — a new REST endpoint, or the existing
   controller WebSocket (`/ws/productions/:id/controller`, `src/ws/controller.ts:1586-1589`)?
2. **How is the forwarded state modelled** — a new persisted CouchDB document, or transient
   in-memory per-production state like tally / overlay alpha?

## Decision

1. **Event ingress is the controller WebSocket**, as a new `HTML_SOURCE_EVENT` arm of the existing
   zod `InboundMessageSchema` discriminated union (`src/ws/controller.ts:196`), with an
   `HTML_SOURCE_STATE` broadcast for echo/snapshot. Every other live operator command
   (`CUT`, `TRANSITION`, `GRAPHIC_ON/OFF`, `SET_OVL`, `MACRO_EXEC`, the audio surface) already lives
   here and is already authenticated by the `API_KEY` gate on the `/ws/` prefix
   (`src/server.ts:276`). Forwarding operator events is a control-plane action, so it belongs on the
   control plane, not on REST.
2. **Forwarded parameters are transient in-memory per-production state** (a
   `htmlSourceParamsByProduction` map), replayed on connect — modelled on `overlayAlphaByProduction`
   (`src/ws/controller.ts:957,1645`) rather than a persisted doc. No CouchDB schema change in the
   first slice. Persistence (like `pipConfigs`, `src/db/types.ts:143-149`) is deferred as an Open
   Question until real usage argues for it.
3. **The resulting effective URL is always re-validated with `graphicUrl()`**
   (`src/lib/url-validation.ts:184`) before any reload, so event-forwarding cannot smuggle an SSRF
   target or disallowed scheme past the gate that guards source creation.

The concrete Strom reload transport (live `cefsrc` element-`url` update vs a page-owned reload) is
**explicitly left open** in the spec (Open Question 1): the Strom client wraps block-property PATCH
(`src/lib/strom.ts:838`) but not element-property PATCH (`src/lib/strom.ts:805-809`), so that leg
needs a maintainer/Strom decision.

## Consequences

- **Positive:** reuses the authenticated, rate-limited WS command path and its connect-time snapshot;
  no new auth surface; additive to the discriminated union so existing clients ignore the unknown
  type; no migration.
- **Positive:** keeps Open Live a generic transport — the payload is opaque key/value params, honoring
  the #187 "no per-graphic logic" guardrail.
- **Negative / deferred:** the actual reload into the running `cefsrc` is not yet a wrapped Strom
  capability; option (a) implies a coordinated Strom change. A naive reload can flash the page on
  air. Both are tracked as Open Questions in the spec, not resolved here.
- **Reversible:** if a REST or persisted-state need emerges from real usage, it is additive; this ADR
  does not preclude it.
