# Spec: HTML-source event-forwarding surface

**Status: Proposed** (architect draft — spec-only, no implementation)
**Author:** architect agent
**Related issues:** #268 (this spec); #187 (OL-3 build/decline decision — resolved **Build** by
@svensson00 on 2026-09-15). Out of scope: the audio half of the YLE workaround (strom#708 /
strom#710) — a separate track.

> Proposed spec, not an accepted decision. The Open Questions below need a maintainer/product call
> before implementation sub-issues are cut. This document designs a **thin, generic event-forwarding
> transport** for HTML sources; it deliberately defines **no per-graphic logic** inside Open Live.

## Problem Statement

Open Live already supports **HTML sources**: a source with `streamType: 'html'` whose `address` is a
browser URL (`src/routes/sources.ts:15,20-26`; `src/db/types.ts:27,31-44`). On production activation
the flow generator renders that URL into the mixer with a Chromium Embedded Framework element —
`cefsrc` with `properties: { url: source.address }` feeding a `cefdemux`
(`src/lib/flow-generator.ts:525-545`). The URL is validated for SSRF via `graphicUrl()`
(`src/lib/url-validation.ts:184-196`): http/https only, no private IPs, no `file:`/`javascript:`, no
`data:text/html`.

What is missing (the YLE rally production, #187): once an HTML source is live, an operator has **no
way to tell it to do anything** — advance a lower-third, load the next graphic state, refresh. The
HTML page is a black box that only ever renders its initial URL. Operators drive Open Live from
Bitfocus Companion and the Studio UI over the controller WebSocket
(`/ws/productions/:id/controller`, `src/ws/controller.ts:1586-1589`), but that command vocabulary
(`src/ws/controller.ts:196-256`) has no verb that reaches an HTML source.

This spec defines a **generic event-forwarding surface**: relay an operator event (from Companion /
Studio UI) through Open Live into the HTML source, with **URL-parameter re-load control as the
minimum first slice**. Open Live stays a transport — it does not interpret graphic semantics.

### Grounding (what exists, and the gap)

- HTML source model & validation: `src/db/types.ts:27-44`, `src/routes/sources.ts:12-66`.
- HTML source → `cefsrc` render: `src/lib/flow-generator.ts:525-545` (`properties: { url }`).
- Controller WS command union (zod `InboundMessageSchema`): `src/ws/controller.ts:196-256`;
  outbound `broadcast(productionId, {...})` / per-socket `ws.send({type:'ERROR',...})`
  (`src/ws/controller.ts:670-675`, `1003`).
- Strom client: `flows.updateBlockProperties` exists for **blocks**
  (`src/lib/strom.ts:838`), but for **GStreamer elements** such as `cefsrc` only
  `elements.list/get/pads` are wrapped (`src/lib/strom.ts:805-809`) — there is **no element
  property PATCH** helper today. This shapes the transport choice (Open Question 1).

## Scope

**In scope (minimum first slice):**
1. A generic operator-event verb on the controller WS that targets an HTML source in the active
   production and carries a small, opaque parameter payload.
2. **URL-parameter re-load control**: the event mutates the HTML source's effective URL query string
   and reloads the `cefsrc`, so the page re-renders with the operator-supplied parameters.
3. State/echo broadcast so every connected client (Studio, Companion) sees the current HTML-source
   parameters, and a connect-time snapshot entry.

**Explicitly out of scope:**
- Any per-graphic / per-template logic in Open Live (no "lower-third", "score", "clock" verbs). The
  payload is opaque key/value parameters; meaning lives entirely in the HTML page.
- The audio half of the YLE workaround (strom#708 / strom#710).
- A bidirectional channel from the HTML page back to Open Live (page → operator). Not needed by the
  single-production evidence; see Open Question 4.
- Multi-HTML-source fan-out semantics beyond addressing one source at a time.

## API Design

### WS command (client → server): `HTML_SOURCE_EVENT`

Added to the existing discriminated union `InboundMessageSchema` (`src/ws/controller.ts:196`),
following the established `z.object({ type: z.literal(...) , ... })` pattern and the existing
per-field bounds (compare `elementIdSchema = z.string().min(1).max(128)`,
`src/ws/controller.ts:166`).

```ts
// New arm of InboundMessageSchema (src/ws/controller.ts)
z.object({
  type: z.literal('HTML_SOURCE_EVENT'),
  sourceId: z.string().min(1).max(128),          // references SourceDoc._id ("src-<uuid>")
  // Minimum first slice: URL-parameter re-load control.
  params: z.record(
    z.string().min(1).max(64),                   // param key
    z.string().max(1024),                        // param value (opaque to Open Live)
  ),
  mode: z.enum(['replace', 'merge']).default('merge').optional(),
  // 'merge' updates/adds the given keys on the source's current effective query;
  // 'replace' sets the query to exactly `params`. Both trigger a reload.
})
```

Constraints (grounded in existing conventions):
- The **resulting** URL (base `address` + applied `params`) MUST re-pass `graphicUrl()`
  (`src/lib/url-validation.ts:184`) so event-forwarding cannot be used to smuggle an SSRF target,
  a `javascript:`/`file:` scheme, or a private-IP host past the same gate that guards source
  creation. Reject with an `ERROR` frame on failure (mirrors `src/routes/sources.ts:169-171`).
- Total serialized query length is capped (proposed 4096 chars) to bound `cefsrc` URL size.
- Rate limited on the existing per-connection sliding window; classify `HTML_SOURCE_EVENT` as an
  **expensive** message type (`EXPENSIVE_MESSAGE_TYPES`, `src/ws/controller.ts:683`) because it
  triggers a Strom mutation / page reload.

### WS state broadcast (server → clients): `HTML_SOURCE_STATE`

Emitted via `broadcast(productionId, {...})` after a successful event (same mechanism as `GRAPHIC`,
`src/ws/controller.ts:1003`), and replayed in the connect-time snapshot so a freshly-connected
Companion/Studio client can show current parameters:

```ts
{
  type: 'HTML_SOURCE_STATE',
  sourceId: string,
  params: Record<string, string>,   // current effective query parameters
  effectiveUrl: string,             // base address + params, AFTER graphicUrl() validation
  updatedAt: string,                // ISO 8601 UTC
}
```

### Error shape

Reuse the existing per-socket `ERROR` frame (`src/ws/controller.ts:670-675`) — sent only to the
originating socket, not broadcast:

```ts
{ type: 'ERROR', error: string }
```

Cases: unknown/inactive `sourceId`; source is not `streamType: 'html'`; resulting URL fails
`graphicUrl()`; query too long; production not active. This matches how `GRAPHIC_ON/OFF` reports an
unknown overlay (`src/ws/controller.ts:990-992`).

### REST — no new endpoint required for the first slice

The base HTML URL is already managed through the existing sources CRUD:
`GET/POST /api/v1/sources`, `PATCH /api/v1/sources/:id` (`src/routes/sources.ts:83-204`). A `PATCH`
to `address` already re-validates via `graphicUrl()` (`src/routes/sources.ts:164`). Live
event-forwarding is a **control-plane** action and belongs on the controller WS alongside every
other operator command, not on REST — consistent with `CUT`/`GRAPHIC_ON`/`SET_OVL` all living on the
WS, not REST.

## Data Model

**No new persisted document type.** The event-forwarding payload is transient operator state, like
tally / overlay-alpha, which Open Live already keeps in per-production in-memory maps
(e.g. `overlayAlphaByProduction`, `src/ws/controller.ts:957`) and replays on connect.

Proposed additive, in-memory only:
- `htmlSourceParamsByProduction: Map<productionId, Map<sourceId, Record<string,string>>>` — the
  current effective parameters per HTML source, sourced for `HTML_SOURCE_STATE` and the connect
  snapshot. Resets on server restart (documented); on reconnect the client resyncs from the
  snapshot, matching how existing WS state is handled (`src/ws/controller.ts:1645`).

**Optional persistence (Open Question 3):** if operators expect parameters to survive
deactivate/reactivate (as `pipConfigs` do, `src/db/types.ts:143-149`), add an optional
`ProductionSourceAssignment.htmlParams?: Record<string,string>` or a source-scoped field. Deferred:
the single-production evidence does not yet justify it.

### Migration

Purely additive. The new WS command and state event are additive to the discriminated union;
existing Studio/companion clients that ignore unknown event types keep working. No CouchDB schema
change for the first slice. `docs/controller-websocket.md` gains the two new rows.

## Service Interactions

```mermaid
sequenceDiagram
    participant Op as Companion / Studio UI
    participant OL as open-live WS controller
    participant Strom
    participant HTML as HTML source (cefsrc page)

    Op->>OL: WS HTML_SOURCE_EVENT { sourceId, params, mode }
    OL->>OL: load ProductionDoc; find source (streamType=html, active)
    OL->>OL: compute effective URL = address + params
    OL->>OL: graphicUrl(effectiveUrl)  // SSRF / scheme gate
    alt validation fails
        OL-->>Op: ERROR { error }
    else ok
        OL->>Strom: reload cefsrc with new url (see Open Question 1)
        Strom->>HTML: navigate to effectiveUrl (page re-renders)
        OL-->>Op: HTML_SOURCE_STATE { sourceId, params, effectiveUrl } (broadcast)
    end

    Note over Op,OL: client reconnects
    Op->>OL: WS connect
    OL-->>Op: HTML_SOURCE_STATE (per active html source, from snapshot)
```

## Configuration

No new environment variables required for the first slice. Reuses the existing `API_KEY` auth gate
for the WS upgrade (`src/server.ts:276`, `docs/controller-websocket.md` "Authentication") and the
existing SSRF allowlist behaviour of `graphicUrl()` / `httpUrlOnly()`
(`src/lib/url-validation.ts:100-132`). If a query-length or param-count cap needs to be tunable, it
should be a constant in `src/config.ts` rather than a new env var until real usage argues otherwise.

## Open Questions (need a human/maintainer decision)

1. **Transport into the running `cefsrc` (the core question).** Two grounded options:
   - **(a) Element-property reload.** Update the `cefsrc` element's `url` property on the running
     flow. Today the Strom client wraps only block-property PATCH (`src/lib/strom.ts:838`), **not**
     element properties (`elements` has `list/get/pads` only, `src/lib/strom.ts:805-809`). This
     needs a new Strom endpoint/helper and confirmation that `cefsrc` re-navigates on a live `url`
     change without rebuilding the pad graph (`cefdemux` links, `flow-generator.ts:544-545`).
   - **(b) Page-owned URL params + reload.** Open Live only ever changes the query string and asks
     the page to reload; the page reads its own params. This is the most "generic transport, no
     per-graphic logic" reading of #187, but still needs a reload primitive (element `url` update
     or flow rebuild). **Which is the intended first slice?** This is the single biggest decision
     and should be answered with the Strom maintainers.
2. **Reload disruption.** Any `cefsrc` reload re-renders the page — visible on air if the source is
   in PGM. Is a mid-show reload acceptable for the first slice, or must the surface guarantee a
   non-disruptive parameter update (which pushes toward a page-side messaging channel, expanding
   scope)? Product call.
3. **Persistence across deactivate/reactivate.** Persist effective params on the production doc (like
   `pipConfigs`) or keep them in-memory only (like overlay alpha)? Recommend in-memory for the first
   slice; revisit if usage argues otherwise.
4. **Direction.** First slice is one-way (operator → page). Is a page → operator channel (e.g. page
   reports "ready"/"finished") ever in scope, or permanently out? Affects whether the event name
   should be generic enough to grow.
5. **Addressing multiple HTML sources.** First slice targets one `sourceId` per event. Confirm no
   need for broadcast-to-all-HTML-sources in the first slice.

## Risks

- **Transport not yet available in the Strom client (Open Question 1).** The clean element-`url`
  reload path is not wrapped today (`src/lib/strom.ts:805-809`); picking option (a) means a
  coordinated Strom change. Mis-scoping this is the main schedule risk.
- **On-air disruption from reload (Open Question 2).** A naive reload flashes the page on program.
  If unacceptable, the "thin transport" premise is challenged and scope grows.
- **SSRF / injection via forwarded params.** Event-forwarding must funnel the *resulting* URL back
  through `graphicUrl()` (`src/lib/url-validation.ts:184`); skipping that re-opens the #58 SSRF
  bypass class through a new door. Non-negotiable in implementation.
- **Scope creep toward a graphics engine.** Pressure to add per-graphic verbs would violate the #187
  guardrail. The opaque `params` contract must be held.
- **Single-production evidence.** Only the YLE rally exercises this. Keep the surface minimal and let
  real usage argue for expansion (#187 guidance).
