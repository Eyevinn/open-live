# Graphics in Open Live

This guide explains how graphics overlays work in an Open Live production: how they fit into
the vision-mixing pipeline, how they are authored, registered, assigned to a downstream keyer
(DSK), and taken on air. It also covers where standards-based tooling such as
[OGraf](https://github.com/ebu/ograf) and the [SPX graphics controller](https://github.com/TuomoKu/SPX-GC)
fit relative to what Open Live implements today.

> **Scope note.** Everything under [How graphics work in Open Live](#how-graphics-work-in-open-live),
> [Authoring a graphic](#authoring-a-graphic), [Registering a graphic](#registering-a-graphic-into-a-production),
> and [On-air operation](#on-air-operation) is backed by code in this repository and in
> [open-live-studio](https://github.com/Eyevinn/open-live-studio). Sections marked
> **External / authoring-side** describe third-party tools that produce a URL Open Live can
> consume; sections marked **Not yet implemented** describe an integration the codebase does
> **not** provide today. See [What is not implemented](#what-is-not-implemented-yet) for the
> honest gap list.

## How graphics work in Open Live

A graphic in Open Live is a named entry with a single `url`. When a production is activated,
each graphic that has been assigned to a DSK pad is rendered by a **Chromium (`cefsrc`)
element** inside the Strom pipeline and composited onto the programme output through a
**downstream keyer (DSK)** on the vision mixer.

Because the renderer is a full Chromium instance pointed at a URL, the graphic can be either:

- a **raster image** — an `http(s)://` image URL, or a `data:image/(png|jpeg|gif|webp)` URI; or
- an **HTML page** served over `https://` — a self-contained web page that draws the graphic
  (lower third, bug/logo, ticker/crawl, full-frame) and, if you want live updates, animates or
  reads data on its own.

This HTML path is exactly where a standards-based HTML graphic such as an
[OGraf](https://github.com/ebu/ograf) template fits: OGraf templates are HTML, and Open Live
renders HTML via Chromium, so a hosted OGraf template URL can be registered as an Open Live
graphic. Open Live does **not** contain any OGraf-specific parsing, bundling, or a template
control channel — it renders the URL you give it. See
[What is not implemented](#what-is-not-implemented-yet).

### Security constraint on graphic URLs

Graphic URLs are validated by `graphicUrl()` in
[`src/lib/url-validation.ts`](../src/lib/url-validation.ts) (enforced on the API in
[`src/routes/graphics.ts`](../src/routes/graphics.ts) and mirrored in the Studio UI):

- `http(s)://` URLs are allowed (private/loopback/link-local hosts are rejected to prevent SSRF
  from the pipeline).
- `data:` URIs are allowed **only** for `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- `data:text/html`, `data:image/svg+xml`, `file://`, and `javascript:` are **rejected**.

The practical consequence: an **HTML graphic must be served from a trusted `https://` URL** — it
cannot be pasted inline as a `data:` URI. Host your OGraf template (or any HTML template) at a
reachable https URL, then register that URL.

### Authenticated HTML sources (token-in-URL, v1)

An HTML source behind a login can be rendered today **only** if the provider offers a
signed/expiring share or access link: put that token-bearing URL in the source `address` and the
renderer navigates to it like any other `https://` URL. This is **Design D** of
[`docs/specs/authenticated-html-sources.md`](specs/authenticated-html-sources.md) (ADR-003) and is
the only authenticated-HTML mechanism in v1.

Operator trade-off — read before relying on it:

- The token lives in the URL you provide. Use the **shortest-lived, revocable** token the provider
  supports; a long-lived token in a source address is a long-lived credential.
- This is **not** equivalent to a stored per-source credential. Per-source stored credentials and
  isolated persisted login profiles (Designs B/C) are deferred pending an upstream `gstcefsrc`
  capability — token-in-URL does not provide credential rotation, masking-on-read, or
  interactive/MFA login.
- Open Live treats a token-bearing `address` as a secret **in its logs** (redacted in
  `src/lib/log-redact.ts` and the server logger), but it cannot control how the *provider* logs the
  token, nor does it mask the token in the source read API — the operator chose to place it there.

### API and WebSocket surface

Graphics touch three parts of the API server. All of this is the authoritative, code-backed
surface; the REST routes are also in [`docs/openapi.yaml`](openapi.yaml) and the WebSocket
messages in [`docs/controller-websocket.md`](controller-websocket.md).

**Graphics catalogue (REST)** — [`src/routes/graphics.ts`](../src/routes/graphics.ts):

| Method & path | Purpose |
|---|---|
| `GET /api/v1/graphics` | List all graphics |
| `POST /api/v1/graphics` | Create a graphic (`{ name, url }`) |
| `GET /api/v1/graphics/:id` | Fetch one graphic |
| `PATCH /api/v1/graphics/:id` | Update `name` / `url` |
| `DELETE /api/v1/graphics/:id` | Delete (409 if assigned to an active production) |

A graphic document (`GraphicDoc` in [`src/db/types.ts`](../src/db/types.ts)) is just
`{ id, name, url, createdAt, updatedAt }`.

**Assigning a graphic to a DSK pad (REST)** —
[`src/routes/productions.ts`](../src/routes/productions.ts):

| Method & path | Purpose |
|---|---|
| `POST /api/v1/productions/:id/graphics` | Assign a graphic to a DSK pad (`{ graphicId, dskInput }`) |
| `DELETE /api/v1/productions/:id/graphics/:dskInput` | Remove the assignment on that pad |

`dskInput` must match the pad naming convention `dsk_in_N` (e.g. `dsk_in_0`, `dsk_in_1`); it is
validated by `dskInputSchema` because the value is forwarded verbatim into a Strom flow link.
The mapping is stored as `ProductionGraphicAssignment { graphicId, dskInput }`.

**Live control (WebSocket)** — `/ws/productions/:id/controller`, handled in
[`src/ws/controller.ts`](../src/ws/controller.ts):

| Inbound message | Fields | Effect |
|---|---|---|
| `GRAPHIC_ON` | `overlayId` | Marks the overlay active; broadcasts `GRAPHIC { overlayId, active: true }` |
| `GRAPHIC_OFF` | `overlayId` | Marks the overlay inactive; broadcasts `GRAPHIC { overlayId, active: false }` |
| `DSK_TOGGLE` | `layer`, `visible?` | Calls Strom `mixer.toggleDsk(dsk = layer + 1)`; broadcasts `DSK_STATE { layer, visible }` |

`DSK_TOGGLE` is the message that actually keys the graphic in or out of the programme feed on
air — it drives the Strom vision mixer's DSK. `GRAPHIC_ON`/`GRAPHIC_OFF` toggle the `active`
flag on a production's `graphics[]` overlay list and are also usable as macro actions
(`GRAPHIC_ON` / `GRAPHIC_OFF` / `DSK_TOGGLE` are valid `MacroAction` types in
[`src/routes/macros.ts`](../src/routes/macros.ts)), so an operator can bind "take lower third"
to a Stream Deck button.

### How the DSK is wired at activation

When a production is activated, [`src/lib/flow-generator.ts`](../src/lib/flow-generator.ts)
walks `production.graphicAssignments` and, for each `dsk_in_N` assignment, builds a `cefsrc`
element with `properties.url = graphic.url`, formats it to the programme resolution, links it
into the mixer's `dsk_in_N` pad, and sets `num_dsk_inputs` on the vision mixer so the pad
exists. So the graphic's URL is fetched and rendered by the pipeline, not by the browser.

## Authoring a graphic

There are two ways to produce the `url` you register.

### Raster images

For a static logo/bug or a pre-rendered full-frame, host a PNG/JPEG/GIF/WebP (or paste a small
raster `data:` URI) and use that URL directly. This needs no external tooling.

### HTML templates (OGraf) — external / authoring-side

For dynamic graphics (animated lower thirds, tickers, data-driven full-frames) author an HTML
template. Open Live is agnostic about how the HTML is produced — it only needs a reachable
`https://` URL — but the recommended standards-based path is
[OGraf](https://github.com/ebu/ograf), the EBU open specification for HTML-based broadcast
graphics, authored with:

- the **[OGraf Template Editor](https://github.com/Eyevinn/ograf-editor)** (also runnable on OSC:
  [eyevinn-ograf-editor](https://app.osaas.io/browse/eyevinn-ograf-editor)) — design the graphic,
  define its data inputs, and export the `.ograf.zip` bundle;

Refer to those projects' own documentation for authoring, data tokens, and the `.ograf.zip`
bundle format — this guide does not duplicate them.

> **Important — how OGraf relates to Open Live.** Open Live has no OGraf-aware endpoint. It does
> not ingest a `.ograf.zip`, does not host the template for you, and does not speak the OGraf
> renderer/controller protocol. What it consumes is a plain URL. To use an OGraf template you
> must host its rendered HTML somewhere reachable over `https://` yourself, then register that
> URL as an Open Live graphic (below). Any per-frame data updates must be driven by the template
> itself (e.g. the page polls or opens its own connection); Open Live's `GRAPHIC_ON`/`GRAPHIC_OFF`
> and `DSK_TOGGLE` only show/hide the whole layer — they do not push text/data into the template.

## Registering a graphic into a production

Via the Studio UI (recommended):

1. Open the **Setup** page → **Graphics** panel
   ([`open-live-studio/src/pages/SetupPage/GraphicsPanel.tsx`](https://github.com/Eyevinn/open-live-studio/blob/main/src/pages/SetupPage/GraphicsPanel.tsx)).
2. Click **+ New Graphic**, give it a name (e.g. "Lower Third") and the URL (image URL, small
   raster `data:` URI, or your hosted HTML template URL). The panel validates the URL the same
   way the API does.
3. Assign it to a DSK pad on the production
   (`POST /api/v1/productions/:id/graphics` with `{ graphicId, dskInput }`). Studio surfaces the
   pads as **DSK 1** (`dsk_in_0`) and **DSK 2** (`dsk_in_1`).

Via the API directly:

```bash
# 1. Create the graphic
curl -X POST "$OPEN_LIVE_URL/api/v1/graphics" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"Lower Third","url":"https://graphics.example.com/lower-third/"}'
# -> { "id": "gfx-....", ... }

# 2. Assign it to DSK pad 0 on the production
curl -X POST "$OPEN_LIVE_URL/api/v1/productions/$PROD_ID/graphics" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"graphicId":"gfx-....","dskInput":"dsk_in_0"}'
```

Assignments must be in place **before** activation, because the DSK wiring is built from
`graphicAssignments` when the Strom flow is generated.

## On-air operation

In the Studio **Controller** page:

- The **Graphics** panel
  ([`open-live-studio/.../ControllerPage/GraphicsPanel.tsx`](https://github.com/Eyevinn/open-live-studio/blob/main/src/pages/ControllerPage/GraphicsPanel.tsx))
  lists the graphics assigned to each DSK pad for the active production.
- The **DSK** panel
  ([`open-live-studio/.../ControllerPage/DskPanel.tsx`](https://github.com/Eyevinn/open-live-studio/blob/main/src/pages/ControllerPage/DskPanel.tsx))
  shows one button per assigned pad (DSK 1 / DSK 2). Clicking a button sends
  `DSK_TOGGLE { layer, visible }` over the controller WebSocket, keying the graphic **in** or
  **out** of the live programme output. The button lights when the layer is on air, and the
  state is replayed to any controller that connects mid-show (`DSK_STATE`).
- You can also bind graphics/DSK actions to a **macro** (Stream Deck) so a single button takes a
  lower third in and out.

## Worked example — lower third on air

1. **Author.** In the [OGraf Template Editor](https://github.com/Eyevinn/ograf-editor), build a
   lower-third HTML template and publish/host it so it is reachable at, say,
   `https://graphics.example.com/lower-third/`. (Any HTML host works; OGraf is the recommended
   authoring path.)
2. **Register.** Setup → Graphics → **+ New Graphic**: name "Lower Third", URL
   `https://graphics.example.com/lower-third/`.
3. **Assign.** Assign that graphic to **DSK 1** (`dsk_in_0`) on your production.
4. **Activate** the production. The pipeline spins up a Chromium `cefsrc` that renders the
   template into DSK 1.
5. **Take on air.** On the Controller page, click **DSK 1**. Open Live sends `DSK_TOGGLE` and the
   lower third keys over the programme output. Click it again to take it out.

## What is not implemented yet

To keep this guide accurate, the following are **not** part of the Open Live codebase today:

- **SPX graphics controller integration (SPX-GC).** There is no SPX-specific code, endpoint,
  configuration, or protocol handling in `open-live` or `open-live-studio` (no reference to
  `spx`/`SPX` exists in either repo). Open Live does not expose an OGraf renderer that
  [SPX-GC](https://github.com/TuomoKu/SPX-GC) can drive, and there is no rundown / play /
  continue / stop / update-data bridge from SPX into Open Live. The community discussion in
  [Eyevinn/strom#243](https://github.com/Eyevinn/strom/issues/243) frames OGraf-via-Open-Live as
  a direction — upstream/aspirational, not a shipped feature here. Until an
  SPX bridge exists, treat SPX as an external authoring/playout tool that is not wired to Open
  Live.
- **OGraf-native ingest / control.** Open Live does not accept a `.ograf.zip`, does not host
  templates, and does not implement the OGraf renderer or controller protocol. It renders a URL.
  Live text/data updates into a template are the template's own responsibility, not something
  Open Live pushes.
- **Live per-field data updates from Open Live.** The WebSocket API can show/hide a graphic layer
  (`GRAPHIC_ON`/`GRAPHIC_OFF`) and key a DSK (`DSK_TOGGLE`); it has no message to update the text
  or data of a rendered template.

If these gaps are closed in future, this document should be updated to describe the real
mechanism rather than the current URL-based approach.
