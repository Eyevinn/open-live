# Spec: Video clip ("story") playback — cue and play via API and WebSocket

**Status: Accepted** (OQ1–OQ4 decided on #206/#278 by @svensson00, 2026-09-16; amended for
issue #307 to reflect the reactive-state + cue-persistence rework as implemented)
**Author:** architect agent
**Related issues:** #206 (epic), #209 (automation contract — consumes this), #307 (OQ2/OQ3 reconciliation)

> Accepted. The four Open Questions are resolved below (see "Resolved Open Questions"); the
> data-model and completion-signalling sections are amended to match what shipped for #307.

## Problem Statement

Newsroom / rundown-driven workflows need a **cue-then-play** clip ("story") source: a clip is
preloaded and preview-ready ahead of time, then played on air at the exact moment the rundown
calls for it, with predictable low latency and no operator interaction. Open Live has no clip
source concept and no cue/play control today.

Grounding in the current code:
- Sources are `SourceDoc` with `streamType: 'srt' | 'efp' | 'whip' | 'test1' | 'test2' | 'html'`
  (`src/db/types.ts:28`). There is no clip/file source type.
- Sources are assigned to mixer inputs via `ProductionSourceAssignment { sourceId, mixerInput }`
  and `POST /api/v1/productions/:id/sources` (`src/db/types.ts:88-96`, `src/routes/productions.ts:644`).
- **Strom already has a media player block API** wrapped in the client
  (`src/lib/strom.ts:875-889`): `player.getState`, `player.control({action})`,
  `player.setPlaylist({files})`, `player.seek({position_ms})`, `player.goto({index})`.
  `PlayerAction = 'play' | 'pause' | 'stop' | 'next' | 'previous'` and
  `PlayerStateResponse = { state: 'playing'|'paused'|'stopped', current_file?, position_ms?, duration_ms?, playlist? }`
  (`src/lib/strom.ts:433-445`). This is the primitive cue/play maps onto — no new Strom
  capability is required.
- The WS controller (`/ws/productions/:id/controller`, `src/ws/controller.ts:1513`) is a
  discriminated-union command channel validated by zod (`src/ws/controller.ts:149-208`) with
  broadcast events (`TALLY`, `PIP_STATE`, `DSK_STATE`, `OVL_STATE`, `AUDIO_STATE`, `GRAPHIC`,
  `FTB_STATE`, `MACRO_EXECUTED`, `ERROR`) and a connect-time sync sequence
  (`src/ws/controller.ts:1541-1615`). New clip commands/events slot into these existing unions.

The epic touches the production/playout state machine and both control surfaces (REST + WS),
and later Studio and the companion module, so it needs a spec.

## API Design

### Clip source model

Add a clip source type. Two viable shapes (see Open Question 1):
- **(a)** extend `StreamType` with `'clip'` and treat it like any other source assigned to a
  mixer input, OR
- **(b)** a dedicated clip resource. This spec proposes **(a)** to reuse the existing
  source-assignment and tally machinery.

```
StreamType = 'srt' | 'efp' | 'whip' | 'test1' | 'test2' | 'html' | 'clip'
```

A `clip` `SourceDoc` carries a **typed, versioned, extensible clip reference** rather than a
bare `address` URL string. Per PM direction on #206, the reference is a discriminated union so
new byte sources (object storage, time-addressable media) can be added without breaking the
contract or reinterpreting an overloaded string. The existing `SourceDoc.address` field
(`src/db/types.ts:33-43`) is retained for storage compatibility and holds a **serialized form**
of this reference (a JSON string), so the additive data model stays backward compatible; the
API contract, however, exposes the structured `ClipReference` below.

```ts
// v1 baseline: any fetchable file / object-storage URL. A presigned URL reduces to this.
interface ClipReferenceUrl {
  type: 'url';
  url: string;
  timerange?: string;   // optional; see below — nothing assumes a fixed file length
}

// Object storage (MinIO / S3 objects from epic #5).
interface ClipReferenceS3 {
  type: 's3';
  bucket: string;
  key: string;
  timerange?: string;
}

// BBC Time-Addressable Media Store (flow + timerange). Reserved variant — see below.
interface ClipReferenceTams {
  type: 'tams';
  store: string;
  flowId: string;
  timerange: string;
}

type ClipReference = ClipReferenceUrl | ClipReferenceS3 | ClipReferenceTams;
```

**Versioning / v1 scope (decided — was Open Question 5, answered by the PM on #206):**
- **v1 implements `url` and `s3`.** A presigned URL for a MinIO/S3 object reduces to the `url`
  variant; the `s3` variant lets `open-live` resolve the object (and presign) itself.
- **`tams` is reserved and NOT implemented in v1**, but the schema must not preclude it. Any
  reference may therefore carry an optional `timerange`, and **nothing in the data model assumes
  media has a fixed file length** (growing/live-appending media). v1 MAY reject growing media at
  cue time, but the reference type and duration/position semantics below must not bake in a
  fixed-length assumption.
- Validation like `src/lib/url-validation.ts` applies to the `url` variant; `s3` validates
  bucket/key against the configured object store. `tams` fields are accepted-but-rejected (501/
  not-implemented) in v1.

On activate, a clip source resolves its `ClipReference` to a Strom media-player block;
`open-live` persists that block id on the production doc (see Data Model). Reference resolution
(URL fetch / S3 presign / — later — TAMS flow lookup) is confined to the resolve step; the
control surface downstream never sees the reference type.

### REST — cue/play/stop/state

```
POST /api/v1/productions/:id/clips/:mixerInput/cue
  body: { clipId?: string }        # cue a specific clip into the ready state
  200 → ClipState
  404 → { error: 'Production not found' } | { error: 'Clip source not found' }
  409 → { error: 'Production is not activated' }

POST /api/v1/productions/:id/clips/:mixerInput/play
  body: { }                        # play the currently cued clip
  200 → ClipState

POST /api/v1/productions/:id/clips/:mixerInput/stop
  200 → ClipState

GET  /api/v1/productions/:id/clips/:mixerInput/state
  200 → ClipState
```

`ClipState` (mirrors Strom `PlayerStateResponse`, camelCased to match `open-live` API style):

```ts
interface ClipState {
  mixerInput: string;
  state: 'idle' | 'cued' | 'playing' | 'paused' | 'stopped' | 'completed' | 'error';
  clipId?: string;
  positionMs?: number;
  durationMs?: number;
  error?: string;
}
```

### WebSocket — commands and events

Add to the inbound discriminated union (`src/ws/controller.ts:84-111` and the zod schema at
`149-208`), reusing the `mixerInputSchema` already defined there:

```
| { type: 'CLIP_CUE';  mixerInput: string; clipId?: string }
| { type: 'CLIP_PLAY'; mixerInput: string }
| { type: 'CLIP_STOP'; mixerInput: string }
| { type: 'CLIP_PAUSE'; mixerInput: string }
| { type: 'CLIP_SEEK'; mixerInput: string; positionMs: number }
```

Add a broadcast event mirroring the existing `broadcast(productionId, { type: ... })` pattern:

```
{ type: 'CLIP_STATE', mixerInput, state, clipId?, positionMs?, durationMs?, error? }
```

`CLIP_STATE` is emitted on every transition (cued, playing, completed, error) and included in
the **connect-time sync** sequence for each clip source, alongside the existing `TALLY` /
`PIP_STATE` / `DSK_STATE` / `OVL_STATE` sync (`src/ws/controller.ts:1560-1613`) — this closes
part of #209's "complete the connect-time snapshot" requirement for clip state.

### State machine

```
idle --CUE--> cued --PLAY--> playing --(end of media)--> completed
 cued --CUE(other)--> cued
 playing --PAUSE--> paused --PLAY--> playing
 playing|paused --STOP--> stopped --CUE--> cued
 any --error--> error --CUE--> cued
```

`cue` = `player.setPlaylist({ files:[clip] })` + `player.goto({index:0})` and leave paused/ready;
`play` = `player.control({ action:'play' })`; `stop` = `player.control({ action:'stop' })`;
`pause` = `player.control({ action:'pause' })`; `seek` = `player.seek({ position_ms })`.

**Reference-type independence (invariant).** The cue → play → completed state machine, the WS
`CLIP_STATE` events, and the `durationMs` / `positionMs` semantics are defined **independently of
the `ClipReference` type**. `cue` resolves the reference (URL fetch / S3 presign / — reserved —
TAMS lookup) to a playable Strom playlist entry and reports `durationMs` plus readiness;
thereafter `play`, `pause`, `stop`, `seek`, and completion behave **identically regardless of the
byte source**. `durationMs` and `positionMs` describe the cued/playing media as reported by
Strom's `player.getState`; they do not presume the reference carried an inline length, so a
`timerange`-scoped or growing reference feeds the same state machine unchanged.

### Error codes

| Code | Condition |
|------|-----------|
| 400  | invalid body/param (zod) |
| 401  | missing/invalid `API_KEY` bearer (when configured) |
| 404  | production or clip source not found |
| 409  | production not activated / no clip cued on `play` |
| 502/503 | Strom unreachable (mirrors `stromErrorMessage` handling in controller) |

## Data Model

Reuse `SourceDoc` (add `'clip'` to `StreamType`). `ProductionDoc` gains an activate-set /
deactivate-cleared map from mixer input to Strom player block id, matching the existing
`sourceOffsetBlockIds` / `sourceAudioOffsetBlockIds` pattern (`src/db/types.ts:172-175`):

```ts
/** Maps mixerInput → media-player block ID for clip sources — set on activate, cleared on deactivate */
clipPlayerBlockIds?: Record<string, string>;
```

**Live** clip state (`playing`/`paused`/`completed`/`error` and playhead position) is held in an
in-memory per-production registry in a small `clip-state` service (mirroring
`src/services/tally.service.ts`) and is driven reactively from Strom's pushed media_player
events (see Completion signalling, below).

**Cue points are persisted** (issue #307 / OQ3): `ProductionDoc` gains a
`clipCues?: Record<string, PersistedClipCue>` map (mixerInput → `{ clipId, positionMs?,
durationMs? }`), written on `CLIP_CUE` and cleared on `CLIP_STOP`/completion via
`src/services/clip-cue-store.ts` (read-merge-write, 409-safe, mirroring the `pipConfigs`
persistence pattern). A cued clip therefore **survives deactivate/reactivate and server
restart**: on the next controller connect a cold registry re-cues Strom to the cue point and
restores the clip to `cued`, and it **never auto-plays on restore**. `clearClipStateForProduction`
(deactivate) deliberately clears only the in-memory registry + poll timers, never `clipCues`.

### Migration

- Adding `'clip'` to `StreamType` and the source-input zod enum is additive/backward compatible.
- The typed `ClipReference` is carried **without a schema change**: `clip` sources store the
  serialized reference (JSON) in the existing optional `SourceDoc.address` field, so no new
  persisted column/field is introduced and existing docs are unaffected. The structured union is
  a contract-level (API/zod) concern; the stored representation stays a string. Because the
  reference may carry a `timerange` and imposes no fixed-length assumption, no length field is
  persisted either.
- The new `clipPlayerBlockIds` and `clipCues` fields are optional; existing docs are unaffected.
  CouchDB is schemaless — no data migration. `clipCues` values use the `PersistedClipCue` shape
  (`{ clipId, positionMs?, durationMs? }`). OpenAPI (`docs/openapi.yaml`) and the WS reference
  (`docs/controller-websocket.md`) must be updated in lockstep, including the `ClipReference`
  discriminated union and its v1-implemented (`url`, `s3`) vs reserved (`tams`) variants.

## Service Interactions

```mermaid
sequenceDiagram
    participant Auto as Automation / Studio
    participant WS as open-live WS controller
    participant Strom

    Auto->>WS: CLIP_CUE { mixerInput, clipId }
    WS->>Strom: player.setPlaylist({files:[clip]}) + goto{index:0}
    WS-->>Auto: CLIP_STATE { state: 'cued' } (broadcast)

    Auto->>WS: CLIP_PLAY { mixerInput }
    WS->>Strom: player.control({action:'play'})
    WS-->>Auto: CLIP_STATE { state: 'playing', positionMs, durationMs }

    Note over WS,Strom: WS subscribes to media_player push events (primary)
    Strom-->>WS: MediaPlayerPosition { position_ms } (while playing)
    WS-->>Auto: CLIP_STATE { state: 'playing', positionMs }
    Strom-->>WS: MediaPlayerStateChanged { state: 'stopped' } (end of media)
    WS-->>Auto: CLIP_STATE { state: 'completed' }
    Note over WS,Strom: player.getState poll is a reconciliation fallback only
```

### Completion signalling (issue #307 / OQ2 — reactive, poll as fallback)

`CLIP_STATE` — including playhead position while playing — is emitted **reactively** from Strom's
pushed media_player events. Strom broadcasts `MediaPlayerStateChanged` and `MediaPlayerPosition`
over its flow WebSocket (`backend/src/blocks/builtin/mediaplayer/bridge.rs:555,577` and
`builder.rs:389`, relayed by `backend/src/api/websocket.rs`). `open-live` adds those two variants
to the `FlowEvent` union (`src/lib/strom.ts`) and consumes them in a reactive clip-relay
(`src/services/clip-relay.ts`, modelled on `meter-relay.ts`): one WS per production, ref-counted
across controller connections, translating each event to a `CLIP_STATE` broadcast keyed back to
the owning `mixerInput`. The relay never downgrades a controller-owned `cued`/`completed`/`error`
state (which Strom cannot represent) on a raw `stopped`/`paused` push.

`CLIP_STATE_POLL_MS` polling of `player.getState` is retained **only as a reconciliation
fallback** for the window when the push channel is briefly unavailable (relay reconnecting). It is
resilient to a transient tick error — a single failure is logged and swallowed, and the poll is
NEVER self-terminated (the old behaviour stranded the clip as `playing`, fixed under #307). It
self-stops once it has reconciled a `playing` clip to `completed`, or once the clip is no longer
locally `playing`.

## Configuration (env vars)

No new env vars strictly required — clip playback reuses the existing `STROM_URL` /
`STROM_AUTH_MODE` client config (`src/config.ts`). Optional:

| Env var | Default | Purpose |
|---------|---------|---------|
| `CLIP_STATE_POLL_MS` | `250` | Interval of the `player.getState` **reconciliation-fallback** poll (issue #307 / OQ2). The primary path is reactive push events; this poll only converges a `playing` clip to `completed` if the push channel is briefly unavailable. |

## Resolved Open Questions

All four were answered by @svensson00 on #206 (2026-09-16); OQ2/OQ3 were reconciled with the
shipped code under #307.

1. **OQ1 — Clip source shape → `StreamType` extension.** Extend `StreamType` with `'clip'` and
   reuse the existing source-assignment and tally machinery; a dedicated resource isn't worth the
   parallel plumbing. (Implemented in #275.)
2. **OQ2 — Completion signalling → reactive push, poll as fallback only.** Strom pushes player
   state (`MediaPlayerStateChanged`) and playhead position (`MediaPlayerPosition`) over its WS
   API. `open-live` subscribes and emits `CLIP_STATE` (including position while playing)
   reactively; `CLIP_STATE_POLL_MS` polling is retained only as a reconciliation fallback. See
   **Completion signalling** above. (Implemented in #307 — the original #278 shipped poll-only.)
3. **OQ3 — Cue persistence → a cued clip survives.** A cued clip survives deactivate/reactivate
   and server restart, restored to `cued` at the cue point, never auto-playing on restore — same
   persistence rule as PiP layout and tally. Persisted on `ProductionDoc.clipCues` via
   `clip-cue-store.ts`. See **Data Model** above. (Implemented in #307 — the original #278 was
   in-memory and wiped the cue on deactivate.)
4. **OQ4 — Cue semantics vs on-air → cue is a pure preload, orthogonal to tally.** Cueing does
   NOT seize the preview bus; the cued clip shows in its own source tile and goes on air via the
   normal `SET_PVW`/`TAKE` path. #209 automation owns switching explicitly.

> **Resolved (formerly Open Question 5 — clip ingest/storage / accepted address forms).** The PM
> answered this on #206: the clip reference is the typed, versioned `ClipReference` union defined
> in **API Design → Clip source model** (v1 implements `url` and `s3`; `tams` reserved), stored
> serialized in `SourceDoc.address`. It is now an incorporated, decided element of the data model,
> not an open question. `src/lib/url-validation.ts` applies to the `url` variant.

## Risks

- **Timing predictability:** rundown automation demands low-latency, predictable play. If
  completion is poll-based, jitter up to the poll interval is exposed to integrators; document it.
- **Preview-bus interaction:** conflating cue with preview could fight the existing PGM/PVW tally
  model (which #209 already flags as under-modelled for PiP). Keep clip state orthogonal to
  vision-mixer tally unless Open Question 4 says otherwise.
- **Player-block availability:** assumes the media-player block is present in the running flow.
  If the flow-generator does not emit a player block for `clip` sources, cue/play will 409/502
  until the generator is extended (implementation task, not an external dependency).
- **Contract stability:** #209 will publish this WS vocabulary as part of a versioned contract;
  name the commands/events deliberately now to avoid a breaking rename later.
