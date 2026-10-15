# Spec: Allow users to choose which audio stream an SRT/input uses

- Issue: [Eyevinn/open-live#511](https://github.com/Eyevinn/open-live/issues/511) — "Allow users to choose which audio stream an SRT/input uses" (split from #508; needs-spec half)
- Status: Draft (architect, Phase 1 — pre-implementation; `skills/epic-workflow.md` §Phase 1)
- Repos affected: `Eyevinn/open-live` (backend + flow generator), `Eyevinn/open-live-studio` (controller UI), and a **load-bearing Strom capability** (see §5.3 / §7.1)
- Companion ADR: [`docs/decisions/ADR-006-audio-stream-selection.md`](../decisions/ADR-006-audio-stream-selection.md)
- Type: cross-service feature (new API field + persisted config + pipeline audio mapping + UI control)

---

## 1. Problem Statement

An MPEG-TS stream delivered over SRT (and an EFP/SRT stream) can carry **more than one
audio elementary stream** — e.g. a program mix on the first stream and a commentary or
clean/international feed on the second. Open Live today has no way for an operator to pick
which of those audio streams an input uses: it always takes the first one, and that choice
is hard-wired in the pipeline builder.

Evidence that the current model is single-audio-stream and the choice is implicit:

- A source is persisted as `SourceDoc` (`src/db/types.ts:161-199`). The only SRT/EFP decode
  parameters it carries are `address` (the SRT URI, `types.ts:166`) and `latency?`
  (`types.ts:170-171`). **There is no audio-stream/track field.**
- The flow generator instantiates one `builtin.mpegtssrt_input` / `builtin.efpsrt_input`
  block per SRT/EFP source, with properties built *only* from `source.address` and
  `source.latency` (`src/lib/flow-generator.ts:870-879`).
- The input's audio is then wired from a single hard-coded pad — `audio_out_0` — into the
  per-source audio `time_offset` block and on to the vision-mixer and audio-mixer inputs
  (`src/lib/flow-generator.ts:892-895`). `audio_out_0` is literally the only audio pad the
  input block exposes (`docs/strom-block-config.md:50-58`: `builtin.mpegtssrt_input` pads are
  `video_out`, `audio_out_0`).
- The audio-channel numbering code assumes exactly one audio stream per source — *"Stream
  type never skips a channel: every type carries audio"* (`src/lib/audio-channels.ts:49-52`).

So "stream 0" is not a decision the operator can see or change; it is a constant in the
wiring. The issue asks to make it a first-class, operator-chosen value, **with the default
staying the first stream** (the sibling default-stream bug — issue #511 "Dependencies" — is
assumed landed first so that "first stream" is already sane).

**The hard part is not storing an index — it is that the Strom input block does not currently
expose any way to select among multiple audio streams** (it has one `srt_uri`, one `latency`,
one `audio_out_0`). Delivering this feature therefore depends on a Strom-side capability that
does not yet exist (§5.3, §7.1), exactly the kind of upstream pipeline dependency ADR-004
gated on. This spec defines the Open Live contract and the migration/validation strategy so
that the backend and UI are ready the moment that capability lands, and degrade safely until
then.

---

## 2. API Design

The selection is read and written through the **existing sources resource**
(`src/routes/sources.ts`), which already has the right shape: zod-validated bodies, a
`toApi()` projection, and `GET` / `POST` / `PATCH` handlers. No new top-level resource is
introduced. Two things are added: a persisted selection field (set via the existing `PATCH`),
and a read-only discovery sub-resource.

### 2.1 What exists today

`GET /api/v1/sources` (`src/routes/sources.ts:289`) and `GET /api/v1/sources/:id`
(`src/routes/sources.ts:363`) return each source through `toApi()`
(`src/routes/sources.ts:232-264`), which renames `_id`→`id`, strips `_rev`/`type`/
`authHeaderValueEnc`/`auth`, and spreads the remaining fields (`...rest`). Current SRT source
response (schema `Source`, `docs/openapi.yaml:166-186`):

```jsonc
// GET /api/v1/sources/:id  (current)
{
  "id": "src-3f1c…",
  "name": "Camera 1 (SRT)",
  "address": "srt://192.0.2.10:9000?mode=caller",
  "streamType": "srt",
  "status": "active",
  "latency": 125,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z"
}
```

Writes go through `SourceInput` (`src/routes/sources.ts:120-136`) on create and `SourcePatch`
(`src/routes/sources.ts:138-158`) on patch — both zod objects with `.superRefine()`
cross-field validation; patch fields are all `.optional()`.

### 2.2 New persisted field: `audioStreamIndex`

Add an optional, non-negative integer `audioStreamIndex` to the source shape. It is the
0-based index of the audio elementary stream the input should use. **Absent means index 0** —
identical to today's behaviour (§3, §6 fallback).

- **Read** — surfaced automatically on every source response. Because `toApi()` spreads
  `...rest` (`src/routes/sources.ts:235-238`), a new non-secret scalar field on `SourceDoc`
  appears on the response with no code change. (This is the inverse of the `toApi()`
  secret-leak gotcha in `docs/repo-patterns.md` — here exposure is *desired*; the field
  carries no credential, so the spread is correct and no explicit projection is needed.)

- **Write** — via the existing `PATCH /api/v1/sources/:id` (`src/routes/sources.ts:373`) and
  accepted on create via `POST /api/v1/sources` (`src/routes/sources.ts:302`). Add to both zod
  schemas:

  ```ts
  // SourceInput (src/routes/sources.ts:120) and SourcePatch (:138)
  audioStreamIndex: z.number().int().min(0).optional(),
  ```

Example patch and response:

```jsonc
// PATCH /api/v1/sources/src-3f1c…
{ "audioStreamIndex": 1 }

// 200 OK
{
  "id": "src-3f1c…",
  "name": "Camera 1 (SRT)",
  "address": "srt://192.0.2.10:9000?mode=caller",
  "streamType": "srt",
  "status": "active",
  "latency": 125,
  "audioStreamIndex": 1,
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-04T12:00:00.000Z"
}
```

### 2.3 Validation and error codes

Follow the error conventions already in `src/routes/sources.ts` (`{ error, statusCode }`
bodies):

| Condition | Code | Notes |
|---|---|---|
| `audioStreamIndex` not a non-negative integer | **400** | zod `z.number().int().min(0)` rejects it; mirrors the existing shape (`sources.ts:308`, `:398`). |
| `audioStreamIndex` set on a non-SRT/EFP source (`whip`/`html`/`clip`) | **400** | Only `srt`/`efp` inputs demux multiple MPEG-TS audio streams. Enforce in the `.superRefine()` (same place `validateSourceAddress` runs, `sources.ts:134`, `:157`) against the effective `streamType` (`sources.ts:385`). |
| Unknown source id | **404** | `{ error: 'Source not found', statusCode: 404 }` (`sources.ts:368`). |
| `audioStreamIndex` out of range of the streams *actually present* | see §2.4 | **Not** rejected at write time — the authoritative stream count is not known at write time (§5.3). Validated/surfaced at discovery and activation instead. |

**Not guarded by 409-on-air.** `audioStreamIndex` is a *non-live* decode property, exactly
like `latency` and `address`: changing it on a source that is assigned to an active production
is accepted and takes effect on the **next (re)activation**, not immediately. This matches the
current PATCH behaviour, which only 409s for an auth-material change
(`isSourceInActiveProduction`, `src/routes/sources.ts:210-218`, applied at `:442`) — latency
and address changes are already allowed on an in-use source. A future live-switch capability
(§7.3) could change this; for v1 do **not** add a 409 guard, and document the
"applies on reactivation" semantics in `docs/openapi.yaml`.

### 2.4 New read-only discovery sub-resource

To let the UI *list* the available streams rather than ask the operator to guess an index, add
a read-only sub-resource modelled on the existing `GET /api/v1/sources/:id/auth/profile/status`
sub-resource (`src/routes/sources.ts:550`):

```
GET /api/v1/sources/:id/audio-streams
```

```jsonc
// 200 OK — discovery available (requires the Strom capability in §5.3/§7.1)
{
  "selectedIndex": 1,          // the persisted audioStreamIndex, or 0 when absent (the effective default)
  "discovery": "available",
  "streams": [
    { "index": 0, "codec": "aac", "channels": 2, "language": "eng" },
    { "index": 1, "codec": "aac", "channels": 2, "language": "swe" }
  ]
}

// 200 OK — discovery not yet possible (no live flow / Strom lacks the probe)
{
  "selectedIndex": 1,
  "discovery": "unavailable",
  "reason": "no-live-flow",   // enum: 'no-live-flow' | 'strom-probe-unsupported'
  "streams": null
}
```

- `404` if the source id is unknown (same as `GET /:id`).
- The `streams` array is **derived, never persisted** — it reflects what the live flow / Strom
  reports at read time, so it can never go stale against the real feed (same read-time-derive
  principle `docs/specs/srt-output-address.md` §3 applies to a Strom-dependent value).
- Until the Strom capability exists, this endpoint always returns `discovery: "unavailable"`
  with `reason: "strom-probe-unsupported"`, so Studio can fall back to a free numeric input
  (§5.3). This keeps the API contract stable across the capability landing.

`selectedIndex` is always present (it is local state), so the UI can show the current choice
even when the stream list cannot be enumerated.

---

## 3. Data Model

**Decision: `audioStreamIndex` lives per-source on `SourceDoc`, added additively with no
CouchDB migration.** (This is the significant choice the companion ADR-006 records.)

```ts
// src/db/types.ts, inside SourceDoc (161-199), alongside `latency?` (170-171)
/**
 * 0-based index of the audio elementary stream this input uses (issue #511).
 * Only meaningful for streamType 'srt' | 'efp' (multi-audio MPEG-TS). Additive
 * and defaulted-absent — every existing source stays valid unchanged; absent
 * means index 0 (the first stream), identical to pre-#511 behaviour.
 */
audioStreamIndex?: number;
```

### 3.1 Per-input vs per-production-use — resolved

The issue's open question is whether the selection belongs to the **source** (so every
production that uses the feed shares it) or to the **per-production use of the source** (so the
same physical SRT feed can take stream 0 in one show and stream 1 in another). The alternative
home would be `ProductionSourceAssignment` (`src/db/types.ts:556-569`), whose optional
`returnFeed?` object (`:568`) is the precedent for a per-assignment config blob.

**Resolved: per-source for v1.** Rationale, grounded in the code:

1. The audio-stream choice is a *decode parameter of the feed*, in the same category as
   `latency` and `address`, which already live on `SourceDoc` (`types.ts:166`, `:170-171`) and
   nowhere else.
2. The block that consumes it is built **per source** from `source.*` in the flow generator
   (`src/lib/flow-generator.ts:870-879`), so the value flows naturally from `SourceDoc` to the
   pipeline with no new plumbing through the production/assignment layer.
3. It is the minimal additive change with the simplest migration (§3.2) and a trivial Studio
   surface (the existing source edit form, §5.1).

A per-production override (`ProductionSourceAssignment.audioStreamIndex?`) is a clean future
extension if a real need appears: resolution would be "assignment value ?? source value ?? 0",
evaluated at `flow-generator.ts:874`. It is **out of scope for v1** and recorded as such in
ADR-006. This is an engineering-consistency call, not a product trade-off, so it is decided
here and not escalated.

### 3.2 Migration strategy

**None required** — follow the established additive-optional pattern used for every recent
`SourceDoc` field (`gatewayId?` `types.ts:192-196`, `auth?` `types.ts:170-181`), each
documented *"additive and defaulted-absent — every existing source stays valid unchanged"*.

- Existing source docs have no `audioStreamIndex`; the reader treats `undefined` as `0`
  (§6). No `MigrationStateDoc` marker and no doc rewrite is needed — this is deliberately
  **not** the heavier one-time-migration path used by
  `src/services/migrate-audio-channel-order.ts` (that pattern is only for fields that must be
  back-filled onto existing docs; a defaulted-absent read does not).
- CouchDB optimistic concurrency is unchanged: the PATCH handler already merges
  `{ ...doc, ...body, updatedAt }` and re-`insert`s with `_rev` (`src/routes/sources.ts:457`).

---

## 4. Service Interactions

Two flows: (a) the operator sets the selection and it is applied on activation; (b) the UI
discovers the available streams.

```mermaid
sequenceDiagram
    actor Op as Operator
    participant Studio as Open Live Studio
    participant API as open-live API (sources.ts / audio-streams)
    participant DB as CouchDB (SourceDoc)
    participant Gen as flow-generator.ts
    participant Strom as Strom / GStreamer

    Note over Op,Strom: (a) Set the selection
    Op->>Studio: pick audio stream in source edit form
    Studio->>API: PATCH /api/v1/sources/:id { audioStreamIndex: 1 }
    API->>API: zod validate (int>=0, srt/efp only) — 400 on bad input
    API->>DB: insert { ...doc, audioStreamIndex: 1, updatedAt }
    API-->>Studio: 200 toApi(doc) incl. audioStreamIndex
    Note right of Studio: non-live; takes effect on next (re)activation

    Note over Op,Strom: activation applies it
    Op->>API: activate production
    API->>Gen: generateFlow(sources…)
    Gen->>Gen: read source.audioStreamIndex (default 0)
    Gen->>Gen: set input-block audio-stream selector + pick audio pad (§5.3)
    Gen->>Strom: flows.start(flow JSON)
    Strom-->>Strom: demux selected audio stream -> audio_out -> mixer

    Note over Op,Strom: (b) Discover available streams
    Op->>Studio: open source edit form
    Studio->>API: GET /api/v1/sources/:id/audio-streams
    API->>Strom: probe live flow for input audio streams (if available)
    Strom-->>API: stream list (or unsupported)
    API-->>Studio: { selectedIndex, discovery, streams|null }
    Studio-->>Op: show stream list + current selection (or numeric fallback)
```

The media path never touches Open Live: Strom demuxes and routes the chosen audio stream
inside the pipeline. Open Live's job is to persist the choice, hand it to the flow generator,
and surface the available streams.

---

## 5. Configuration

### 5.1 Studio UI (open-live-studio)

- Extend `ApiSource` (`src/lib/api.ts:106-126`) and the store mirror `Source`
  (`src/store/sources.store.ts:8-24`, `fromApi()` `:56-69`) with `audioStreamIndex?: number`.
- Add the control to the source edit form: `EditState` (`SourcesPanel.tsx:252-280`) and the
  save path `handleEdit()` (`SourcesPanel.tsx:467-533`, PATCH built at `:524-529` through
  `sourcesApi.update`, `src/lib/api.ts:371`). Show it only for SRT/EFP sources (reuse `isSrt()`
  `SourcesPanel.tsx:56` / `STREAM_TYPE_HAS_LATENCY` `:44-52`, where `latency` already renders).
- Populate the picker from `GET /api/v1/sources/:id/audio-streams` (§2.4). When `discovery` is
  `"unavailable"`, render a plain non-negative number input defaulting to the current
  `selectedIndex` — never block editing on discovery being present.

### 5.2 Environment variables

**None.** No new env var is required — the selection is per-source data, not deployment config.

### 5.3 Strom pipeline JSON shape change

The selection has to reach the `builtin.mpegtssrt_input` / `builtin.efpsrt_input` block. Today
that block exposes only `srt_uri` + `latency` and a single `audio_out_0` pad
(`docs/strom-block-config.md:50-58`), and the generator wires `audio_out_0` unconditionally
(`src/lib/flow-generator.ts:892`). There is **no existing property or pad for stream
selection** (confirmed: no `audio_stream`/`audio_pid`/`audio_out_1` anywhere in `src/`). So one
of two Strom-side shapes is needed — this is the load-bearing upstream dependency (§7.1):

- **Option A — a selector property on the input block (recommended).** Strom adds a property
  (proposed name `audio_stream_index`, 0-based, default 0) that selects which demuxed audio
  elementary stream is emitted on the existing `audio_out_0` pad. Open Live change is minimal
  and additive — one property at `flow-generator.ts:874-877`, wiring unchanged:

  ```jsonc
  // builtin.mpegtssrt_input / builtin.efpsrt_input block (flow-generator.ts:870-879)
  "properties": {
    "srt_uri": "srt://192.0.2.10:9000?mode=caller",
    "latency": 125,
    "audio_stream_index": 1        // NEW (proposed Strom property; default 0)
  }
  ```

- **Option B — multiple audio output pads.** Strom exposes `audio_out_0 … audio_out_{N-1}`
  (one per demuxed stream), and the generator changes the link at `flow-generator.ts:892` from
  the hard-coded `audio_out_0` to `audio_out_${audioStreamIndex}`. More flexible (enables
  routing several streams at once later) but a larger pipeline-shape change and needs the pad
  count known at build time.

ADR-006 recommends **Option A** (minimal, additive, matches how `latency` is already a
scalar block property). Either way the exact property/pad name **must be confirmed against the
live `GET /api/blocks` `exposed_properties`** before implementation — per the standing rule in
`docs/strom-block-config.md` (header + Agent Rule 9), the runtime OpenAPI schema is
authoritative and this spec must not invent a name that is not there. A Strom issue tracking
the capability is a prerequisite recorded in §7.1.

---

## 6. Open Questions (resolved unless flagged)

1. **Where the selection lives — per-input vs per-production-use.** **Resolved: per-source on
   `SourceDoc.audioStreamIndex`** (§3.1), with a per-production override deferred as a clean
   future extension on `ProductionSourceAssignment`. Engineering-consistency call (mirrors
   `latency`), decided here.

2. **How streams are discovered — static config vs probed from the live flow.** **Resolved:
   both, layered.** The *selection* is static persisted data (`audioStreamIndex`); the
   *available-stream list* is discovered at read time via `GET …/audio-streams` (§2.4). Since
   no stream-probe facility exists in the codebase today (no ffprobe / SRT stream metadata —
   confirmed) and the Strom input block does not report its streams, discovery returns
   `unavailable` until the Strom capability (§5.3) lands, and the UI falls back to a numeric
   input. Cross-team dependency, tracked in §7.1 — not a product trade-off.

3. **Behaviour when the selected index is absent on the actual feed.** **Resolved: fall back
   to the first stream (index 0) and never hard-fail the flow.** This matches the issue's
   "default remains the first stream" and the single-audio assumption the pipeline already
   makes (`src/lib/audio-channels.ts:49-52`). Concretely: the flow generator clamps an
   out-of-range / absent selection to `0` when building the block, and — once discovery (§2.4)
   can confirm the real stream count — the backend surfaces a **non-fatal warning** (via the
   `audio-streams` response and, if a live flow is up, the existing source `liveIngest`-style
   read channel) rather than refusing activation. Losing audio because a feed changed its
   stream layout mid-event is a worse failure than silently using stream 0.

4. **Channel-level vs stream-level selection.** The issue notes the source report mentions
   *channel pairs 1&2 / 3&4*. This spec scopes v1 to **stream-level** selection: choosing which
   audio *elementary stream* (PID) the input uses. Whether operators also need **intra-stream
   channel-pair** selection (e.g. one stereo stream carrying two language pairs, selecting
   1&2 vs 3&4 within it) is a genuine product/requirements trade-off — it materially changes
   the data model (an index is no longer enough; you need a stream + a channel-pair/mapping)
   and the mixer-input fan-out in `src/lib/audio-channels.ts`. **@svensson00 — please confirm
   whether v1 needs intra-stream channel-pair selection, or whether stream-level selection is
   sufficient and channel-pair routing can be a follow-up epic.** The rest of this spec assumes
   stream-level; if channel-pairs are required for v1, `audioStreamIndex` generalises to an
   `audioSelection?: { streamIndex: number; channelPair?: number }` object and §5.3's Strom
   capability must also expose channel-pair routing.

---

## 7. Risks

- **Upstream Strom gap — the feature cannot ship without it (§5.3).** The input block has no
  stream-selection property or multi-audio pad today (`docs/strom-block-config.md:50-58`;
  nothing in `src/`). Like ADR-004's dependence on strom#783/#840, implementation is **gated**
  on a Strom capability + a confirmed property/pad name from live `GET /api/blocks`. Mitigation:
  the Open Live contract (field + discovery endpoint) is defined so backend/UI land green and
  degrade to "stream 0 only / numeric fallback" until Strom ships; file and link a Strom issue
  before Phase 2.
- **Inventing a pipeline shape.** Guessing `audio_stream_index` / `audio_out_N` names risks
  drift from Strom reality. Mitigation: standing rule — confirm against runtime
  `exposed_properties` (`docs/strom-block-config.md` header + Agent Rule 9) before wiring;
  flag any drift.
- **Silent wrong-audio / lost-audio.** A persisted index that no longer matches the live feed
  could route the wrong stream or (worse) no audio. Mitigation: clamp-to-0 fallback + non-fatal
  warning (§6 Q3); never hard-fail activation on a stale index.
- **`toApi()` spread.** `audioStreamIndex` rides the `...rest` spread (`src/routes/sources.ts:235-238`)
  — correct here (non-secret, exposure desired), but the spread is the exact mechanism behind
  the secret-leak gotcha in `docs/repo-patterns.md`; the implementer must not reuse this field's
  "just spread it" treatment for any future credential-bearing source field.
- **Single-audio assumption elsewhere.** `src/lib/audio-channels.ts:49-52` hard-assumes one
  audio stream per source for channel numbering. Stream-level selection (one stream → one
  channel strip) keeps that invariant; a channel-pair extension (§6 Q4) would break it and
  needs that code revisited. Mitigation: keep v1 stream-level unless §6 Q4 says otherwise.
- **Low blast radius for the chosen shape.** Per-source additive field, no migration, no new
  env var, non-live (applies on reactivation) — so the data-model change itself cannot disturb
  a running pipeline; all risk concentrates in the Strom wiring, which is gated.

---

## 8. Implementation checklist (ordered, file-level) — hand-off scope

**Prerequisite (cross-team):**
0. Strom capability for audio-stream selection (§5.3 Option A recommended) — file/track a
   Strom issue; confirm the property/pad name against live `GET /api/blocks`. Gates steps 5–6.

**Backend (`Eyevinn/open-live`) — backend-developer:**
1. `src/db/types.ts`: add `audioStreamIndex?: number` to `SourceDoc` (near `latency?`, :170).
2. `src/routes/sources.ts`: add `audioStreamIndex: z.number().int().min(0).optional()` to
   `SourceInput` (:120) and `SourcePatch` (:138); in each `.superRefine()` (:133, :150) reject
   a non-zero/absent index on non-srt/efp effective `streamType` with a 400.
3. `src/routes/sources.ts`: add `GET /api/v1/sources/:id/audio-streams` (§2.4), modelled on the
   `auth/profile/status` sub-resource (:550); 404 on unknown id; `discovery: "unavailable"`
   until the Strom probe exists.
4. `docs/openapi.yaml`: extend `Source` (:166), `SourceInput` (:215), `SourcePatch` (:236) with
   `audioStreamIndex`; document the "applies on reactivation" semantics and add the
   `audio-streams` path.
5. `src/lib/flow-generator.ts`: at the input-block build (:874-877) read
   `source.audioStreamIndex ?? 0`, clamp out-of-range to 0, and apply the Strom shape from §5.3
   (Option A: set the selector property; Option B: wire `audio_out_${index}` at :892).
6. Tests: zod accept/reject (int≥0, non-srt/efp→400); `toApi` round-trips the field;
   flow-generator sets the selector / picks the pad for a non-zero index and clamps a stale one
   to 0; `audio-streams` returns `selectedIndex` + the unavailable fallback.

**Frontend (`Eyevinn/open-live-studio`) — frontend-developer (after backend on staging):**
7. `src/lib/api.ts`: add `audioStreamIndex?: number` to `ApiSource` (:106) and a
   `getAudioStreams(id)` call for `GET …/audio-streams`.
8. `src/store/sources.store.ts`: thread the field through `Source` (:8), `fromApi()` (:56) and
   `updateSource` (:121-136).
9. `src/pages/SetupPage/SourcesPanel.tsx`: add the picker to `EditState` (:252) / `handleEdit`
   (:467) for SRT/EFP sources, populated from discovery with a numeric fallback.
10. Frontend test/visual check: SRT source with 2 streams shows a picker; selection persists via
    PATCH; discovery-unavailable shows the numeric fallback.

Once this spec + ADR-006 are merged and the Strom prerequisite is tracked, #511 can move
**Backlog → Ready** with steps 1–10 as the scope.
