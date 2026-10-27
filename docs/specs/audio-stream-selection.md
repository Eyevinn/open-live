# Spec: Allow users to choose which audio stream an SRT/input uses

- Issue: [Eyevinn/open-live#511](https://github.com/Eyevinn/open-live/issues/511) — "Allow users to choose which audio stream an SRT/input uses" (split from #508; needs-spec half)
- Follow-up issues: #515 (data model + discovery endpoint — **done**, PR #518), [#516](https://github.com/Eyevinn/open-live/issues/516) (flow-generator wiring + Studio warning — this revision)
- Status: Draft, **revised 2026-10-17** for #516 (architect, Phase 1; `skills/epic-workflow.md` §Phase 1). §2–§3 are implemented as written. §1, §4–§8 are revised per @svensson00's 2026-10-15 corrections on #516.
- Repos affected: `Eyevinn/open-live` (backend + flow generator), `Eyevinn/open-live-studio` (controller UI), and a **load-bearing Strom capability** (see §5.3 / §7.1)
- Companion ADRs: [`ADR-006`](../decisions/ADR-006-audio-stream-selection.md) (Decisions 1–3: data model, API, discovery) and [`ADR-010`](../decisions/ADR-010-audio-stream-selection-pipeline-wiring.md) (supersedes ADR-006 Decisions 4–5: pipeline wiring, v1 scope, clamp + warning)
- Upstream dependency: [Eyevinn/strom#1077](https://github.com/Eyevinn/strom/issues/1077) (takeover fix, "Option Park") **plus a PID-order mapping follow-up that is not yet filed** (§7.1)
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

**The hard part is not storing an index. It is that the Strom input block cannot yet route a
*chosen* stream to a *known* output.**

> **Correction (2026-10-17, @svensson00 on #516).** The original text of this section said the
> input block exposes only one `audio_out_0`. That is wrong, and `docs/strom-block-config.md:50-59`
> is incomplete on this point. `builtin.mpegtssrt_input` already has `num_audio_tracks` (UInt,
> default 1, non-live), which creates `audio_out_0` … `audio_out_{N-1}` (Eyevinn/strom
> `backend/src/blocks/builtin/mpegtssrt_input.rs:77-85,682-693` at `8fce2ee`). What is missing
> is a **stable mapping**. A demuxer pad takes the first output nothing feeds
> (`link_to_output`, `mpegtssrt_input.rs:450`), so pad-added order (not PID order) decides which
> stream lands on `audio_out_k`. When every output is fed, the retire branch
> (`mpegtssrt_input.rs:498`, from strom#877) takes over the oldest output. That is the #510 bug,
> filed as strom#1077. Its "Option Park" fix restores "first stream wins" only. Mapping
> `audio_out_k` to the k-th stream in PID order is an upstream follow-up that has **not yet
> been filed**.

Delivering selection for `k > 0` therefore depends on that Strom follow-up (§5.3, §7.1). This
is the same kind of upstream gate ADR-004 had. The Open Live contract (§2–§3) is already shipped
(#518). This revision specifies the flow-generator wiring and the operator warning, so that both
are ready the moment the capability lands and degrade to "first stream + warning" until then.

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

### 2.5 Changed contract (#516): input-scoped activation warning

The sources endpoints (§2.2–§2.4) are **unchanged** by #516. In particular,
`GET /api/v1/sources/:id/audio-streams` keeps returning
`discovery: "unavailable", reason: "strom-probe-unsupported"` (`src/routes/sources.ts:581-597`)
until Strom can report the stream list (§6 Q5).

The one contract change is an **additive variant on `ActivationWarning`**
(`src/lib/flow-generator.ts:82`). Today the union has a single member, `recording-no-audio`. It
is persisted as `ProductionDoc.activationWarnings` (`src/db/types.ts:837`), returned on the
production resource (`GET /api/v1/productions/:id`, written at `src/routes/productions.ts:427`)
and replayed as WS `ERROR` frames on controller connect while the production is active
(`src/ws/controller.ts:4019-4022`):

```ts
// src/lib/flow-generator.ts:82 (and the mirrored type at src/db/types.ts:837)
export type ActivationWarning =
  | { type: 'recording-no-audio'; message: string }
  | {
      type: 'audio-stream-not-applied';
      sourceId: string;          // SourceDoc._id
      mixerInput: string;        // stored assignment key, e.g. 'video_in_3' (the "input" in Studio)
      requestedIndex: number;    // effective SourceDoc.audioStreamIndex (> 0)
      appliedIndex: 0;           // v1 always clamps to the first stream
      reason: 'stream-type-unsupported' | 'strom-capability-missing' | 'stream-not-present';
      message: string;           // human text, also used for the WS ERROR toast
    };
```

```jsonc
// GET /api/v1/productions/:id (active production), excerpt
{
  "status": "active",
  "activationWarnings": [
    {
      "type": "audio-stream-not-applied",
      "sourceId": "src-3f1c…",
      "mixerInput": "video_in_3",
      "requestedIndex": 1,
      "appliedIndex": 0,
      "reason": "strom-capability-missing",
      "message": "Camera 1 (SRT): audio stream 2 was not applied, using stream 1. This Strom cannot select an audio stream by PID yet."
    }
  ]
}
```

- **No new endpoint, no new status codes.** The warning never changes an HTTP status.
  Activation still succeeds (`202`/`200` as today), and the input is built on the first stream.
- `mixerInput` is the **stored** key, not the compacted Strom pad (`mixerInputMap`, issue #463),
  so Studio can match it to the input tile directly.
- The `message` text numbers streams 1-based for the operator. The fields stay 0-based like
  `audioStreamIndex`.
- Older Studio builds keep working. They show the existing production-level list and toast,
  and they ignore the extra fields.
- `docs/openapi.yaml` must document the `activationWarnings` item schema as a `oneOf` with both
  variants.

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

### 3.3 #516 data-model change: `activationWarnings` widened (no migration)

`ProductionDoc.activationWarnings?` (`src/db/types.ts:837`) changes its element type from
`{ type: 'recording-no-audio'; message }` to the `ActivationWarning` union in §2.5. It is
additive: existing docs hold only `recording-no-audio` items, which stay valid. The field is
already cleared when a new activation starts (`src/routes/productions.ts:971`) and when
activation fails (`:653`), so no stale `audio-stream-not-applied` items carry into the next run. **No migration.** `SourceDoc` is unchanged
by #516.

---

## 4. Service Interactions

(a) The selection is set (unchanged, shipped in #518). (b) Activation applies it or clamps
and warns (#516). (c) Studio shows the warning on the input. (d) Discovery, unchanged.

```mermaid
sequenceDiagram
    actor Op as Operator
    participant Studio as Open Live Studio
    participant API as open-live API
    participant DB as CouchDB
    participant Gen as flow-generator.ts
    participant Strom as Strom (mpegtssrt_input)

    Note over Op,Strom: (a) Set the selection — shipped (#518)
    Op->>Studio: set audio stream on SRT source
    Studio->>API: PATCH /api/v1/sources/:id { audioStreamIndex: k }
    API->>DB: insert SourceDoc { ...doc, audioStreamIndex: k }
    API-->>Studio: 200 toApi(doc)
    Note right of Studio: non-live: applies on next (re)activation

    Note over Op,Strom: (b) Activation (#516)
    Op->>API: POST /api/v1/productions/:id/activate
    API->>Gen: activateStromFlow(production, sources…)
    Gen->>Strom: GET /api/blocks (+ /api/version) — capability check (once per activation)
    Strom-->>Gen: block definitions
    loop each srt/efp assignment
        Gen->>Gen: k = source.audioStreamIndex ?? 0
        alt k == 0
            Gen->>Gen: block as today (no num_audio_tracks), link audio_out_0
        else streamType efp, or Strom lacks PID-order mapping
            Gen->>Gen: block as today, link audio_out_0 (clamp)
            Gen->>Gen: warnings += audio-stream-not-applied {reason}
        else srt and capability present
            Gen->>Gen: num_audio_tracks = k+1, link audio_out_k → time_offset
            Gen->>Gen: drain audio_out_j (j≠k) → fakesink
        end
    end
    Gen->>Strom: create + start flow
    Gen-->>API: ActivationResult { warnings }
    API->>DB: ProductionDoc.activationWarnings = warnings
    Strom-->>Strom: demux; audio_out_k = k-th audio PID (upstream follow-up)
    opt feed carries fewer than k+1 audio streams (needs upstream §7.1 b)
        Strom-->>Strom: in-block fallback: audio_out_k fed from first stream
        Strom-->>API: runtime signal "output k fell back / unfed"
        API->>DB: append audio-stream-not-applied {reason: stream-not-present}
        API-->>Studio: WS ERROR toast (+ refreshed production state)
    end

    Note over Op,Strom: (c) Studio shows it on the input
    Studio->>API: GET /api/v1/productions/:id   (and WS connect replay)
    API-->>Studio: activationWarnings[]
    Studio-->>Op: warning badge on input tile for mixerInput + tooltip message

    Note over Op,Strom: (d) Discovery — unchanged
    Studio->>API: GET /api/v1/sources/:id/audio-streams
    API-->>Studio: { selectedIndex, discovery: "unavailable", reason: "strom-probe-unsupported", streams: null }
```

The media path never touches Open Live. Strom demuxes and routes the chosen stream inside the
pipeline. Open Live persists the choice, builds the matching flow JSON, decides when it cannot
apply the choice, and reports that per input.

---

## 5. Configuration

### 5.1 Studio UI (open-live-studio)

The source-edit control is shipped. `audioStreamIndex` already exists on `ApiSource`
(`src/lib/api.ts:115`) and is edited in `SourcesPanel.tsx` with the validation helper
`src/lib/audio-stream-index.ts`. #516 adds the **input-scoped warning** only:

- Widen the `activationWarnings` element type in `src/lib/api.ts:237` and `:268` (today a
  literal `recording-no-audio`) to the §2.5 union. Thread it through
  `src/store/productions.store.ts:292` unchanged.
- In the production view, show a warning indicator on the **input** whose stored `mixerInput`
  matches an `audio-stream-not-applied` item, with `message` as the tooltip/label. Typical
  wording: "Audio stream 2 not applied, using stream 1". The existing production-level list
  (`ProductionsPanel.tsx:1171-1177`) keeps rendering every warning's `message`, so nothing is
  lost on screens without input tiles.
- The source edit form shows no extra hint unless the source is in an active production that
  carries a matching warning. If it is, the form shows the same text next to the audio-stream
  field (optional, frontend-developer's call).

### 5.2 Environment variables

**None.** No new env var is needed. The capability is detected from Strom at activation
(§5.3), not configured.

### 5.3 Strom pipeline JSON shape (revised — ADR-010 Decision 1)

No new Strom property is used. The existing `num_audio_tracks` and `audio_out_<N>` pads are
used. Build rules at `src/lib/flow-generator.ts:906-928`, with `k = source.audioStreamIndex ?? 0`:

**k = 0, or k > 0 but not applied (clamp).** The block and links are **byte-identical to
today**:

```jsonc
{ "id": "<inputId>", "block_definition_id": "builtin.mpegtssrt_input",   // or efpsrt_input
  "properties": { "srt_uri": "srt://192.0.2.10:9000?mode=caller", "latency": 125 } }
// links
{ "from": "<inputId>:video_out",   "to": "<offsetId>:in" }
{ "from": "<inputId>:audio_out_0", "to": "<audioOffsetId>:in" }
```

**k > 0, `streamType: 'srt'`, Strom capability present** (example k = 2):

```jsonc
{ "id": "<inputId>", "block_definition_id": "builtin.mpegtssrt_input",
  "properties": {
    "srt_uri": "srt://192.0.2.10:9000?mode=caller",
    "latency": 125,
    "num_audio_tracks": 3                 // = k + 1; existing UInt property, non-live
    // + the PID-order opt-in property IF upstream makes it opt-in (§7.1 c) — name TBC from GET /api/blocks
  } }
// elements (one fakesink per non-selected output, same shape as the loudness drain, flow-generator.ts:1226-1231)
{ "id": "e-audio-drain-<padIndex>-0-<endpointSuffix>", "element_type": "fakesink", "properties": { "sync": false } }
{ "id": "e-audio-drain-<padIndex>-1-<endpointSuffix>", "element_type": "fakesink", "properties": { "sync": false } }
// links
{ "from": "<inputId>:video_out",   "to": "<offsetId>:in" }
{ "from": "<inputId>:audio_out_2", "to": "<audioOffsetId>:in" }      // selected stream
{ "from": "<inputId>:audio_out_0", "to": "e-audio-drain-<padIndex>-0-<endpointSuffix>:sink" }
{ "from": "<inputId>:audio_out_1", "to": "e-audio-drain-<padIndex>-1-<endpointSuffix>:sink" }
```

Rules:

1. **Every `audio_out_0..k` appears in exactly one link.** An unconnected Strom output pad can
   fail the flow at startup (the `group_out_N` precedent, `flow-generator.ts:1237-1238`).
2. Downstream of `<audioOffsetId>` nothing changes. The vision-mixer `audio_in_<pad>` and the
   audio-mixer `input_<ch>` links (`flow-generator.ts:929-931`) and `src/lib/audio-channels.ts`
   numbering are untouched. Stream-level selection keeps one audio stream per input
   (`audio-channels.ts:49-52` invariant holds).
3. **Capability check.** This happens once per activation, following the `stromHasAudioEncoder`
   precedent (`flow-generator.ts:84-95`): read `GET /api/blocks` and, if needed, `GET /api/version`
   (`src/lib/strom.ts:870`), and decide whether `builtin.mpegtssrt_input` maps `audio_out_k` by
   PID order. **The predicate is defined by the upstream follow-up (§7.1 c) and must not be
   guessed.** *(#545: it is `map_audio_by_pid` present in the block's `exposed_properties`,
   and the k > 0 shape also sets `map_audio_by_pid: true`.)* An unreadable block list returns `false`
   for this feature: wiring an unordered `audio_out_k` is the #510 failure mode, so the
   conservative answer here is the opposite of `stromHasAudioEncoder`'s.
4. **EFP (`builtin.efpsrt_input`) is out of v1 scope** (ADR-010 Decision 3). An `efp` source
   with `k > 0` always takes the clamp shape and warns `stream-type-unsupported`.
5. `docs/strom-block-config.md` §`builtin.mpegtssrt_input` is corrected in the implementation PR
   (lists `num_audio_tracks`, `decode`, `tsdemux_latency`, `ignore_pcr`, `wait_for_connection`,
   `auto_reconnect`, `keep_listening`, and pads `audio_out_0..N-1`). That file is outside this
   docs-only spec PR's scope (`docs/specs/**`, `docs/decisions/**`).

### 5.4 When the selection is "not applied" (clamp + warn — ADR-010 Decision 4)

| Case | Detected by | When | Pipeline | `reason` |
|---|---|---|---|---|
| `k = 0` / absent | Open Live | build | today's shape | — (no warning) |
| `efp` source, `k > 0` | Open Live | build | clamp (`audio_out_0`) | `stream-type-unsupported` |
| `srt`, `k > 0`, Strom lacks PID-order mapping (or check fails) | Open Live | build | clamp (`audio_out_0`) | `strom-capability-missing` |
| `srt`, `k > 0`, capability present, feed has < k+1 audio streams | Strom (upstream §7.1 b) | runtime | in-block fallback to first stream (preferred upstream behaviour) | `stream-not-present` |

The flow is **never** failed over `audioStreamIndex`. Each not-applied case yields exactly one
`audio-stream-not-applied` warning per affected `mixerInput`. A source assigned to two inputs
yields two warnings.

---

## 6. Open Questions

Resolved items from the original spec (Q1 per-source, Q2 discovery layering, Q3 fall back to
first + warn) stand. Q4 is now **resolved by @svensson00 (#516, 2026-10-15)**.

1. **Per-input vs per-production-use.** *Resolved* — per-source (§3.1). Unchanged.

2. **PID order vs PMT (program-map) order for "stream k".** @svensson00 and the Strom triage
   both say "k-th stream in PID order". Most encoders allocate audio PIDs in PMT order, so the
   two agree, but nothing guarantees it. Operators read "stream 2" off encoder or analyser UIs,
   which usually list PMT order. **Proposed resolution:** ascending PID order as stated, written
   into the upstream follow-up verbatim. Revisit only if a real feed disagrees. Once discovery
   (Q5) returns `pid` per stream, Studio shows the PID next to each choice, so the ambiguity is
   visible. *Owner: team-lead to confirm with @svensson00 when filing upstream.*

3. **What does Strom do when output k has no stream (feed has < k+1 audio streams)?** Two
   upstream options: (A) in-block fallback, where `audio_out_k` is fed from the first audio stream
   and a runtime signal is emitted; (B) leave `audio_out_k` unfed (silent) and emit a runtime
   signal. Only (A) satisfies "clamp to the first stream" without an Open Live flow restart
   (rejected in ADR-010 because it restarts every input on air). **Proposed resolution:** ask for
   (A) in the follow-up. If Strom only ships (B), Open Live still raises `stream-not-present`, and
   the clamp for that case becomes "next activation builds `k` as not applied" (a degraded but
   honest behaviour). *Owner: team-lead when filing upstream.*

4. **Channel-level vs stream-level.** *Resolved by @svensson00 (#516): stream-level for v1.*
   Out-of-range → clamp to first stream + Studio warning on the input (§5.4). Channel-pair
   selection is a separate future epic. `audioStreamIndex` stays a scalar.

5. **Runtime signal channel and discovery.** How does Strom tell Open Live (i) that output k
   fell back or is unfed (Q3), and (ii) the list of audio streams (PID, codec, channels,
   language) to unblock `GET …/audio-streams`? Candidates are a block-state field readable via
   `strom.flows.get` (polled today at `src/routes/productions.ts:441`) or a Strom WebSocket
   event. **Proposed resolution:** ask for both in the same follow-up, as one read-only
   block-state field per `mpegtssrt_input` instance (e.g. the PMT audio list plus which output
   each stream feeds). Open Live reads it in the existing post-start poll and in the discovery
   endpoint. Exact shape is set upstream and must not be invented here. Until then, only
   build-time reasons are raised and discovery stays `unavailable`.

6. **Capability detection predicate.** How does Open Live know a given Strom maps by PID
   order (§5.3 rule 3)? **Proposed resolution:** prefer an explicit, discoverable signal in the
   block definition (an opt-in property in `exposed_properties`, which also protects existing
   `num_audio_tracks > 1` users from a behaviour change). Fall back to a Strom version floor via
   `GET /api/version`. Decided when the follow-up is filed. The predicate lives in one helper next
   to `stromHasAudioEncoder`.

7. **Upper bound on `audioStreamIndex`.** The API accepts any non-negative integer (#518).
   Building `num_audio_tracks = k + 1` for a mistyped `k = 99` creates 100 decode branches.
   **Proposed resolution:** treat `k > 7` (more than 8 audio streams, beyond any realistic
   contribution feed) as not applied at build time with `reason: 'stream-not-present'`, and do
   not change the API validation (keeps #518's contract). *Owner: backend-developer may tune the
   constant; flag if a real feed needs more.*

8. **EFP in a later version.** *Resolved for v1: out of scope* (ADR-010 Decision 3). A future
   EFP path needs an upstream audio-pinning primitive analogous to `data_stream_ids`
   (`efpsrt_input.rs:40-70`). No action now. Studio could hide the audio-stream field for `efp`
   sources, but the API keeps accepting it. **Proposed resolution:** leave the field visible with
   a "MPEG-TS/SRT only for now" hint rather than hide it (frontend-developer's call).

---

## 7. Risks

### 7.1 Upstream Strom dependency (gating)

- **strom#1077 (open)** — "Option Park" fixes the takeover so that `audio_out_0` carries the
  first stream (fixes #510). It is needed for the default `k = 0` path to be correct, but it does
  **not** enable `k > 0`.
- **PID-order follow-up: [Eyevinn/strom#1081](https://github.com/Eyevinn/strom/issues/1081)**,
  fixed by [Eyevinn/strom#1120](https://github.com/Eyevinn/strom/pull/1120) (`dc2d228`), first
  released in Strom `v0.8.0-alpha.1` (prerelease). It covers:
  (a) `audio_out_k` ← k-th audio stream in ascending PID order, stable across reconnects, in both
      `decode` and passthrough modes, when the opt-in Bool property `map_audio_by_pid` is set;
  (b) in-block fallback to the first stream for a missing k-th stream (Q3 option A), plus a
      runtime element message `strom-mpegtssrt-audio-map` (per-output `pids` / `fallback`) that
      the flows API does **not** expose yet (Q5 open — `stream-not-present` from it is a
      follow-up to #545);
  (c) the capability signal: `map_audio_by_pid` in `builtin.mpegtssrt_input`'s
      `exposed_properties` in `GET /api/blocks` (Q6).
  Open Live implements (a) + (c) in #545 (`stromMapsAudioByPid()`). On a Strom without the
  property (v0.7.2 and earlier) every `k > 0` is still clamped and warns
  `strom-capability-missing`.

### 7.2 Other risks

- **Wiring `audio_out_k` without the capability gate** reintroduces #510 silently.
  *Mitigation:* rule 3 in §5.3, plus a flow-generator test asserting `audio_out_0` + warning
  when the capability check is false.
- **Unconnected output pads.** *Mitigation:* drains (§5.3 rule 1). A test asserts every
  `audio_out_0..k` is linked exactly once.
- **Decode cost.** `decodebin` decodes every exposed audio stream, so `k + 1` streams are
  decoded per input and `k` are discarded. *Mitigation:* Q7 ceiling. A later upstream
  optimisation could skip decoding unlinked outputs.
- **Invented names.** The opt-in property, the runtime signal and the capability predicate are
  deliberately **unnamed** here. *Mitigation:* the standing rule in `docs/strom-block-config.md`
  (confirm against live `GET /api/blocks`).
- **Warning noise.** A source used on several inputs produces one warning per input, which is
  intended (each input tile needs its own). The WS `ERROR` replay on connect
  (`controller.ts:4019-4022`) will toast each one. *Mitigation:* acceptable for v1. Studio may
  de-duplicate toasts by `sourceId`.
- **`toApi()` spread** (unchanged from the original spec): `audioStreamIndex` rides `...rest`.
  Do not copy that treatment for credential-bearing fields.

---

## 8. Implementation checklist (ordered, file-level) — #516 hand-off scope

Steps 1–4 of the original checklist (data model, zod, discovery endpoint, tests) shipped in #518.
`docs/openapi.yaml` coverage of `audioStreamIndex` and `audio-streams` should be verified in
step 5 below.

**Prerequisite (cross-team, gating step 3 only):**
0. team-lead files the Strom PID-order follow-up (§7.1 a–c) and links it from #516 and
   ADR-010. strom#1077 must be merged for the `k = 0` default to be correct (#510).

**Backend (`Eyevinn/open-live`) — backend-developer. Steps 1, 2, 4, 5 can ship before
step 0 lands:**
1. `src/lib/flow-generator.ts:82` + `src/db/types.ts:837`: widen `ActivationWarning` /
   `activationWarnings` to the §2.5 union (one shared type).
2. `src/lib/flow-generator.ts:906-928`: compute `k`. Apply the §5.4 table: for `efp` with `k > 0`,
   or `srt` with `k > 0` and the capability absent, or `k > 7`, build today's shape and push
   `audio-stream-not-applied`. Message text uses 1-based stream numbers and the source name.
3. *(Gated on step 0.)* Add a `stromMapsAudioByPid(strom)` capability helper next to
   `stromHasAudioEncoder` (`flow-generator.ts:84`), using the predicate from the follow-up. When
   it is true and `srt` with `0 < k ≤ 7`: set `num_audio_tracks: k + 1` (+ opt-in property if
   any), link `audio_out_<k>`, and drain `audio_out_<j≠k>` to `fakesink` elements (§5.3).
   Later, once Q5's runtime signal exists, read it in the post-start poll
   (`src/routes/productions.ts:441`) and append `stream-not-present` warnings + WS `ERROR`.
4. Tests (`src/__tests__/flow-generator-*.test.ts`): `k = 0` produces a byte-identical block and
   links to today; `efp` with `k = 1` produces the clamp + `stream-type-unsupported`; `srt` with
   `k = 1` and no capability produces the clamp + `strom-capability-missing`; `k = 9` produces
   the clamp; with the capability mocked true, `k = 2` gives `num_audio_tracks: 3`, `audio_out_2`
   linked to the audio offset, and `audio_out_0/1` each drained exactly once; a source on two
   inputs gives two warnings; `activationWarnings` persists both variants.
5. `docs/openapi.yaml`: `activationWarnings` item `oneOf` (both variants), and confirm the
   `audioStreamIndex` / `audio-streams` entries from #518. `docs/strom-block-config.md`: correct
   the `builtin.mpegtssrt_input` section (§5.3 rule 5).

**Frontend (`Eyevinn/open-live-studio`) — frontend-developer, after backend steps 1–2 are on
staging:**
6. `src/lib/api.ts:237,268`: widen the `activationWarnings` type to the §2.5 union.
7. Production view: a warning indicator on the input matching `mixerInput`, with the
   `message` tooltip. Keep `ProductionsPanel.tsx:1171-1177`'s list. Optional hint in the source
   edit form (§5.1, Q8).
8. Test: an active production with an `audio-stream-not-applied` warning shows the indicator on
   the right input only. A `recording-no-audio` warning still renders as before.

Once this revision + ADR-010 are reviewed and Q2/Q3/Q5/Q6 are carried into the upstream
follow-up, #516 can move **Backlog → Ready** with steps 1, 2, 4–8 as immediately buildable scope
and step 3 gated.
