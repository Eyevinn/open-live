# Spec: ISO recording — record chosen inputs to their own files beside the program recording (OL-32)

- Issue: [Eyevinn/open-live#569](https://github.com/Eyevinn/open-live/issues/569) (OL-32), incl. @svensson00's scope note on open question 0
- Studio half: [Eyevinn/open-live-studio#233](https://github.com/Eyevinn/open-live-studio/issues/233) (OL-32b) — builds against §2 and §8 of this spec, nothing else
- Supersedes: [#410](https://github.com/Eyevinn/open-live/issues/410) (request) / draft [#411](https://github.com/Eyevinn/open-live/pull/411), draft [#489](https://github.com/Eyevinn/open-live/pull/489); see Q4 for what carries over
- Builds on (merged): #553 (time-based parts), #520 (storage connections), #534 (upload target snapshot), #565 (idempotent registration by bucket+key), #566 (live part upload)
- Upstream: [Eyevinn/strom#1034](https://github.com/Eyevinn/strom/pull/1034) `builtin.liverecorder` (merged, Strom v0.7.0, 2026-10-08; latest v0.7.1); [Eyevinn/strom#1057](https://github.com/Eyevinn/strom/pull/1057) exact per-file start time (open, **not required**, see §6)
- Companion ADR: [`ADR-011`](../decisions/ADR-011-live-recorder-iso-recording.md)
- Status: Draft (architect, Phase 1 of `skills/epic-workflow.md`). Code references are to `open-live` main at `931715b` and Strom main at `4abc286`.
- Repos affected: `Eyevinn/open-live` (flow generator, recording pipeline, API, WS, docs), `Eyevinn/open-live-studio` (#233). No Strom change is needed.

---

## 1. Problem statement

Open Live records only the program output. `activateStromFlow` emits exactly one
`builtin.recorder` per production, fed from the `Enc PGM` encode, and ignores any further
`recording` output (`src/lib/flow-generator.ts:1124-1136`, link at `:1149`). Feeds that were never
cut to are lost when the show ends, so there is nothing to re-edit, build highlights from, or check
against (#410).

What is missing, verified on main:

| Gap | Where |
|---|---|
| No per-source opt-in | `ProductionSourceAssignment` has only `sourceId`, `mixerInput`, `returnFeed` (`src/db/types.ts:736-750`); `SourceAssignmentInput` likewise (`src/routes/productions.ts:955-959`) |
| No input metadata on recordings | `RecordingDoc` has no program/input discriminator, `mixerInput`, `sourceId`, source name or guest label (`src/db/types.ts:367-399`) |
| No filters on the listing | `GET /api/v1/recordings` takes no query parameters (`src/routes/recordings.ts:176-191`, `docs/openapi.yaml:1722-1741`) |
| Recorder that stalls on a quiet track | `builtin.recorder` writes through `splitmuxsink`, which holds every track when one stops (strom#1034 "Problem"). Guest feeds drop and resume, so inputs need `builtin.liverecorder` |
| Part start times are not accurate enough to align files | Start is the file-name stamp (`recordingStartFromFileName`, `src/lib/recording-uploader.ts:690`) — taken when the block is **built**, to the second, in Strom's local zone — plus summed part durations (`src/lib/recording-parts.ts:52`). A WHIP guest's first file opens when their media arrives, minutes after the stamp |
| Live Recorder parts would list without a duration | Live Recorder writes fragmented MP4 through `isofmp4mux` without `write-mehd` (strom `live_recorder/mod.rs:252-260`), so `mvhd` duration is 0 and there is no `mehd`; `Mp4DurationScanner` only reads those two (`src/lib/mp4-duration.ts:5-8`) |

### Goals (v1, from #569)

1. Per-source opt-in `record`, default off.
2. Tap each recorded input **before** its `time_offset` blocks (feed as it arrived).
3. One recorder per recorded input, same part length (`RECORDING_SEGMENT_SECS`) and storage as
   program; H.264 + AAC (`transcode`). Program and inputs use the same block type (§4).
4. Same storage, live upload (#566) and idempotent registration (#565) as program. No second upload path.
5. Metadata on each `RecordingDoc` to line files up (kind, `mixerInput`, `sourceId`, source name, guest label, accurate start).
6. API filters (production, activation, input) and a production/WS view of which inputs record.
7. Docs + tests.

Out of scope: SRT/EFP passthrough (needs a Strom change), TAMS store, tag database, replay,
changing `record` while live, multi-file sync player (Studio).

---

## 2. API design

All errors use the existing body `{ error: string, statusCode: number }`; the new 4xx cases add a
machine-readable `reason`, as `RecordingDeleteError` already does (`docs/openapi.yaml:941`).
Every new field is additive; clients must ignore unknown fields and unknown warning `type`s (as
`ActivationWarning` already documents, `docs/openapi.yaml:735-739`).

### 2.1 `ProductionSourceAssignment.record` (new field)

```ts
type InputRecordMode = 'off' | 'transcode';   // 'passthrough' reserved, refused in v1
interface ProductionSourceAssignment {
  sourceId: string;
  mixerInput: string;
  returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean };
  /** Record this input to its own files (OL-32). Absent = 'off'. Read at activation. */
  record?: InputRecordMode;
}
```

Shown wherever assignments are shown today (`ProductionDoc.sources` on every production
response). Stored only when `transcode`; `off` is stored as absent so existing docs and
assignments without the field are identical (AC 4).

### 2.2 `POST /api/v1/productions/{id}/sources` (changed)

Accepts an optional `record`. The route keeps its **replace** semantics
(`src/routes/productions.ts:1308-1333`): a request without `record` turns recording off for that
`mixerInput`, exactly like `returnFeed` today. Studio should use §2.3 to toggle recording so it
does not have to resend the rest of the assignment.

Request (additions only):

```json
{ "sourceId": "src-…", "mixerInput": "video_in_2", "record": "transcode" }
```

Response `201` (the code returns 201; `docs/openapi.yaml:2122` says 200 — fix the doc in the same
change): the stored assignment plus `_rev`, unchanged shape, now including `record` when set.

New errors (only when `record: "transcode"` is sent):

| Status | `reason` | When |
|---|---|---|
| 400 | `record-mode-unsupported` | `record: "passthrough"` (reserved, needs a Strom change) |
| 400 | `record-source-unsupported` | the source's `streamType` is not `whip`, `srt` or `efp` (Q6) |
| 409 | `record-cap-reached` | enabling would exceed `RECORDING_MAX_INPUTS` recorded inputs on this production, or the cap is 0 (Q3) |

The existing 400 (zod body) and 404 (production) behaviour is unchanged.

### 2.3 `PUT /api/v1/productions/{id}/sources/{mixerInput}/record` (new)

Sets or clears recording for one assignment without touching the rest of it. Modelled on
`PUT …/returns/{mixerInput}/mode`.

Request:

```json
{ "record": "transcode" }
```

`record`: `"off" | "transcode"` (required). `mixerInput` path param uses the existing
`mixerInputSchema` (`^video_in_\d{1,2}$`).

Response `200`:

```json
{
  "mixerInput": "video_in_2",
  "sourceId": "src-…",
  "record": "transcode",
  "appliesFrom": "next-activation",
  "currentlyRecording": false,
  "recordingOutputAssigned": true,
  "_rev": "12-…"
}
```

| Field | Meaning |
|---|---|
| `appliesFrom` | Always `"next-activation"` in v1 (Q2). A running production keeps recording exactly the inputs it was activated with. |
| `currentlyRecording` | Whether the **running** activation records this input (from `ProductionDoc.inputRecordings`, §3.2). `false` when the production is not live. |
| `recordingOutputAssigned` | Whether the production has a `recording` output assigned now. `false` with `record: "transcode"` means the next activation will record nothing for this input and will raise `input-recording-no-output` (Q1). Studio shows this as a warning before activation (#233 AC 3). |

Errors:

| Status | `reason` | When |
|---|---|---|
| 400 | — | invalid body or `mixerInput` (zod) |
| 400 | `record-mode-unsupported` | `"passthrough"` |
| 400 | `record-source-unsupported` | source `streamType` not `whip`/`srt`/`efp` |
| 404 | — | production not found, or no assignment on `mixerInput` (`{ error: "Source assignment not found" }`, same text as the DELETE route) |
| 409 | `record-cap-reached` | over `RECORDING_MAX_INPUTS` |
| 503 | — | database unavailable |

Setting `off` never fails for cap or source-type reasons. Writes retry on CouchDB 409 like the
other assignment routes (`MAX_DB_WRITE_RETRIES`).

### 2.4 `GET /api/v1/recordings` and `GET /api/v1/productions/{id}/recordings` (changed)

New optional query parameters, all exact-match, combined with AND:

| Param | Type | Matches |
|---|---|---|
| `productionId` | string, 1-128 | `RecordingDoc.productionId` (only on `/api/v1/recordings`; the per-production route already fixes it) |
| `activationId` | string, 1-128 | `RecordingDoc.activationId` |
| `kind` | `program` \| `input` | `RecordingDoc.kind` (§3.1; legacy docs are migrated to `program`, §3.4) |
| `mixerInput` | `^video_in_\d{1,2}$` | `RecordingDoc.mixerInput` (implies `kind=input`) |
| `sourceId` | string, 1-128 | `RecordingDoc.sourceId` |

- Validated with zod; an invalid value is `400 { error, statusCode: 400 }`. Unknown parameters
  are ignored (no behaviour change for today's callers).
- The selector is built from the validated **string** values and run through the guarded
  `find()` (never `findTrusted`, `src/db/index.ts:103-111`, #257): plain equality, no operators.
- Response `200`: array of `RecordingAsset` (§2.5), sorted by `startedAt` ascending, then
  program before inputs, then `mixerInput`, then `partIndex`, so a client can group by
  `activationId` without re-sorting. The existing `limit: 500` stays (see Risks R7).
- `503` unchanged; the per-production `404` unchanged.

### 2.5 `RecordingAsset` (response shape, additive)

Every `RecordingDoc` field is already echoed by `toApi()` (`src/routes/recordings.ts:66-79`), so
the new fields in §3.1 appear automatically. Documented in `docs/openapi.yaml`:

```jsonc
{
  "id": "recording-…", "productionId": "prod-…", "outputId": "out-…", "connectionId": "conn-…",
  "bucket": "…", "key": "prod-…/video_in_2/prod-…_video_in_2_20261101_180000_00001.mp4",
  "sizeBytes": 123, "durationMs": 300040,
  "startedAt": "2026-11-01T18:05:00.112Z", "endedAt": "2026-11-01T18:10:00.152Z",
  "startedAtSource": "chained",
  "activationId": "flow-…", "partIndex": 1,
  "kind": "input",
  "mixerInput": "video_in_2", "sourceId": "Whip", "sourceName": "Guest 1 · In 3", "streamType": "whip",
  "guestLabel": "Anna",
  "guests": [{ "inviteId": "guest-invite-…", "label": "Anna", "joinedAt": "…", "leftAt": "…" }],
  "recorderType": "liverecorder",
  "playbackUrl": "…", "downloadUrl": "…",
  "createdAt": "…", "updatedAt": "…"
}
```

`GET /api/v1/recordings/{id}` and `DELETE /api/v1/recordings/{id}` are unchanged and work for
input recordings as for program (delete resolves the target from the doc, `recordings.ts:97`).

### 2.6 Production resource (additive)

`GET /api/v1/productions[/{id}]` responses (through `toProductionView`, which already spreads the
doc) gain:

| Field | Set | Meaning |
|---|---|---|
| `inputRecordings` | on activate, cleared on deactivate | The inputs the running activation records: `Array<{ mixerInput, sourceId, sourceName, streamType }>` (block ids and directories are stripped by `toProductionView`, §3.2) |
| `recorderType` | on activate with a recorder, cleared on deactivate | `"liverecorder"` or `"recorder"` — which block records program (and inputs) in this activation |
| `activationWarnings[]` | as today | four new types, §2.7 |

### 2.7 New `ActivationWarning` types

All `{ type, message, … }`, persisted on `ProductionDoc.activationWarnings`, logged, and sent as WS
`ERROR` frames when the production goes active and on connect (existing mechanism,
`docs/controller-websocket.md:228`).

| `type` | Extra fields | Raised when | Effect |
|---|---|---|---|
| `input-recording-unavailable` | `mixerInputs: string[]` | ≥1 assignment has `record: "transcode"` but this Strom has no `builtin.liverecorder` (or `RECORDING_BLOCK=recorder`) | inputs not recorded; program records with `builtin.recorder` exactly as today (AC 8) |
| `input-recording-no-output` | `mixerInputs: string[]` | ≥1 assignment records but no `recording` output is assigned | nothing recorded for those inputs (AC 5) |
| `input-recording-capped` | `mixerInputs: string[]` (the ones skipped) | more recorded assignments than `RECORDING_MAX_INPUTS` (cap lowered after they were set) | the first N by numeric pad index record, the rest are skipped |
| `input-recording-unsupported-source` | `mixerInput`, `sourceId` | an assignment records a source whose type is no longer recordable (source edited after the setting) | that input not recorded |

No warning is raised for a production that records no inputs, on any Strom (AC 4). The existing
`recording-no-audio` stays, and can only occur on the `builtin.recorder` path.

### 2.8 Controller WebSocket: `RECORDING_STATE` (new outbound message)

| `type` | Fields | Emitted when |
|---|---|---|
| `RECORDING_STATE` | `program: boolean`, `inputs: Array<{ mixerInput: string; sourceId: string; sourceName: string }>` | Broadcast when the production reaches `active` (after the activation-warning `ERROR` frames), sent on connect while active, and broadcast once with `program: false, inputs: []` on deactivate (before `PRODUCTION_DEACTIVATED`). |

`program` is true when the activation has a recorder for program. `inputs` mirrors
`ProductionDoc.inputRecordings`. Studio uses it for the per-tile recording indicator (#233 AC 1).
`mixerInput` is the **stored** key, never the compacted Strom pad (same rule as every other
input-keyed frame, `mixerInputMap`, #463).

---

## 3. Data model

### 3.1 `RecordingDoc` (additive)

```ts
interface RecordingDoc {
  // … existing fields unchanged (src/db/types.ts:367-399)
  /** Program or one input's own recording. Required on new docs; backfilled to 'program' (§3.4). */
  kind: 'program' | 'input';
  /** Input recordings only: stored assignment key, e.g. 'video_in_2'. */
  mixerInput?: string;
  /** Input recordings only: SourceDoc._id (or the virtual 'Whip' id). */
  sourceId?: string;
  /** Input recordings only: the label the multiviewer showed at activation ("Guest N · In M" for a WHIP guest slot, else SourceDoc.name). Snapshot: a later rename does not change it. */
  sourceName?: string;
  /** Input recordings only: SourceDoc.streamType at activation ('whip' | 'srt' | 'efp'). */
  streamType?: 'whip' | 'srt' | 'efp';
  /** WHIP guest slots only: guest sessions on this mixerInput that overlap [startedAt, endedAt]. */
  guests?: Array<{ inviteId: string; label?: string; joinedAt: string; leftAt?: string }>;
  /** First of `guests` with a label — a ready list column (AC 3). */
  guestLabel?: string;
  /** Which Strom block wrote the file. Absent on docs written before OL-32 (= 'recorder'). */
  recorderType?: 'liverecorder' | 'recorder';
  /** How startedAt was derived (§6). Absent on docs written before OL-32 (= 'filename'). */
  startedAtSource?: 'strom' | 'event' | 'chained' | 'filename';
}
```

`guests` comes from `GuestSessionDoc` (`inviteId`, `mixerInput`, `createdAt` = joined,
`updatedAt` = left once `state` is `left`) joined to `GuestInviteDoc.label`, the same derivation
#411 used. It is computed at registration time; a re-registration (#565 upsert) recomputes it.

`_id` stays `recordingDocId(bucket, key)` (#565). Input keys differ from program keys (§5.2), so
there is no collision.

### 3.2 `ProductionDoc` (additive)

```ts
interface ActiveInputRecording {
  mixerInput: string;
  sourceId: string;
  sourceName: string;
  streamType: 'whip' | 'srt' | 'efp';
  recorderBlockId: string;   // internal — stripped by toProductionView
  outputDir: string;         // internal — 'recordings/<productionId>/<mixerInput>'
}
interface ProductionDoc {
  // …
  recorderType?: 'liverecorder' | 'recorder';   // set with recorderBlockId, cleared on deactivate
  inputRecordings?: ActiveInputRecording[];    // set on activate, cleared on deactivate
}
```

- Written in the same `updateProductionDoc` as `recorderBlockId` and `recording`
  (`src/routes/productions.ts:597-617`); cleared in `deactivatedDoc` (`:200-238`) next to
  `recorderBlockId` / `recording`.
- Inputs reuse the activation's `ProductionDoc.recording` snapshot (`ActiveRecording`: output,
  connection, start): one storage target per activation (Q1). No per-input target.
- `toProductionView` (`src/routes/productions.ts:178`) strips `recorderBlockId` and `outputDir`
  from each `inputRecordings` entry (repo-patterns "Internal ProductionDoc fields must be stripped").
- `ActivationResult` (`flow-generator.ts:28`) gains `recorderType` and
  `inputRecorders: ActiveInputRecording[]`.

### 3.3 `ProductionSourceAssignment.record`

See §2.1. No migration: absent = off.

### 3.4 Migration

| Change | Strategy |
|---|---|
| `record` on assignments | none — absent = off |
| New `ProductionDoc` fields | none — set on the next activation, absent = no input recording |
| `RecordingDoc.kind` | one-time startup migration `migration:recording-kind-v1` (same `MigrationStateDoc` pattern as `services/migrate-audio-channel-order.ts`, wired in `src/main.ts:133-141`): page through `type: 'recording'` docs without `kind` (literal selector, `findTrusted` with `$exists: false` — no request data) and set `kind: 'program'`. Idempotent per doc; an interrupted run resumes on the next start. Readers still treat a missing `kind` as `program`, so the listing is correct before the migration finishes except for an explicit `kind=program` filter. |
| Other new `RecordingDoc` fields | none — absent on old docs; documented defaults above |

No field is renamed or removed. Rollback: an older build ignores the new fields; recorded inputs'
docs stay listed as plain recordings (they still have `productionId`, `key`, `startedAt`).

---

## 4. Strom pipeline shape

### 4.1 Recorder block selection (per activation)

```
liveRecorderPresent = blocks.list() contains 'builtin.liverecorder'   // capability, not version
use = RECORDING_BLOCK == 'recorder' ? 'recorder'
    : liveRecorderPresent           ? 'liverecorder'
    :                                 'recorder'
```

- Detection reuses the `strom.blocks.list()` pattern of `stromHasAudioEncoder`
  (`flow-generator.ts:140-147`), fetched once per activation. **If the list cannot be read, choose
  `recorder`**: it exists on every Strom we support, so program recording is never lost (opposite
  default to `stromHasAudioEncoder`, deliberately — a Strom that refuses an unknown block refuses
  the whole flow).
- `use = 'liverecorder'`: program **and** inputs on `builtin.liverecorder` (ADR-011).
- `use = 'recorder'`: program exactly as today (`builtin.recorder`, `builtin.audioenc` or
  `recording-no-audio`, split-before-stop). Inputs are not built; `input-recording-unavailable`
  if any were asked for.

### 4.2 Program recorder (Live Recorder path)

Replaces the block at `flow-generator.ts:1134-1147`; everything else about the recording output
(one per production, `recordings/<productionId>`, `filename_prefix: <productionId>`) is unchanged.

```jsonc
{
  "id": "b-out-<idSlug>-<suffix>",
  "block_definition_id": "builtin.liverecorder",
  "name": "<output name>",
  "properties": {
    "output_dir": "recordings/<productionId>",
    "filename_prefix": "<productionId>",
    "max_size_time_secs": 600,          // RECORDING_SEGMENT_SECS; omitted when 0
    "num_video_tracks": 1,
    "num_audio_tracks": 1               // 0 when the production has no main audio
  }
}
// links
{ "from": "<Enc PGM>:video_out", "to": "b-out-…:video_in_0" }
{ "from": "<mainAudioSource>",   "to": "b-out-…:audio_in_0" }   // raw main_out
```

- `container` is left at its default `mp4` (fragmented MP4, strom `live_recorder/mod.rs:84`).
- Live Recorder encodes raw audio to AAC itself (`audioconvert ! audioresample ! avenc_aac`,
  strom `live_recorder/mod.rs:491-496`), so the program path drops `builtin.audioenc` and the
  `recording-no-audio` case. Video must arrive encoded; `Enc PGM` already is H.264.

### 4.3 Input recorder (Live Recorder path only)

For each assignment with `record: 'transcode'` whose source is `whip`/`srt`/`efp`, after the cap,
one recorder holding **both** tracks of the input in **one** file (ADR-011 Decision 3):

```jsonc
// elements
{ "id": "e-inrec-vq-<padIndex>-<suffix>", "element_type": "queue",
  "properties": { "leaky": "downstream", "max-size-buffers": 0, "max-size-bytes": 0, "max-size-time": 1000000000 } }
{ "id": "e-inrec-vmem-<padIndex>-<suffix>", "element_type": "capsfilter",
  "properties": { "caps": "video/x-raw" } }                                        // system memory, see Notes
{ "id": "e-inrec-aq-<padIndex>-<suffix>", "element_type": "queue", "properties": { /* same */ } }
// blocks
{ "id": "b-inrec-venc-<padIndex>-<suffix>", "block_definition_id": "builtin.videoenc",
  "name": "Record <mixerInput> video encoder",
  "properties": { "codec": "h264", "bitrate": 4000, "keyframe_interval": 60 } }   // bitrate = RECORDING_INPUT_VIDEO_BITRATE_KBPS
{ "id": "b-inrec-<padIndex>-<suffix>", "block_definition_id": "builtin.liverecorder",
  "name": "Record <mixerInput>",
  "properties": {
    "output_dir": "recordings/<productionId>/<mixerInput>",
    "filename_prefix": "<productionId>_<mixerInput>",
    "max_size_time_secs": 600, "num_video_tracks": 1, "num_audio_tracks": 1 } }
// links
{ "from": "<videoTap>",                   "to": "e-inrec-vq-…:sink" }
{ "from": "e-inrec-vq-…:src",             "to": "e-inrec-vmem-…:sink" }
{ "from": "e-inrec-vmem-…:src",           "to": "b-inrec-venc-…:video_in" }
{ "from": "b-inrec-venc-…:encoded_out",   "to": "b-inrec-…:video_in_0" }
{ "from": "<audioTap>",                   "to": "e-inrec-aq-…:sink" }
{ "from": "e-inrec-aq-…:src",             "to": "b-inrec-…:audio_in_0" }      // raw; the block encodes AAC
```

Taps — the pad that today feeds the input's `time_offset` blocks, so the file holds the feed as it
arrived (AC 2):

| `streamType` | `videoTap` | `audioTap` | Where today |
|---|---|---|---|
| `whip` | `b-input-<padIndex>-<suffix>:video_out` | `b-input-…:audio_out` | `flow-generator.ts:928-939` |
| `srt` / `efp` | `b-input-<padIndex>-<suffix>:video_out` | `b-input-…:audio_out_0` | `flow-generator.ts:983-1000` |

Notes:

- `builtin.videoenc` / `encoded_out` / `video_in` / `keyframe_interval` / `bitrate` are verified in
  strom `videoenc.rs:1024-1130`. `keyframe_interval: 60` (2 s at the 30 fps browsers send) carries
  over from #411: browser H.264 has irregular keyframes and Strom's WHIP bridge cannot forward a
  keyframe request, so a re-encode is the only way to get clean splits.
- The leaky queue (from #411) gives the encoder its own thread and drops frames from the
  recording rather than back-pressuring the tee that feeds the mixers. A recording may drop; the
  program must not.
- The `e-inrec-vmem-…` capsfilter (`caps: "video/x-raw"`, no caps features, so system memory)
  sits between the leaky queue and the encoder because, on a GPU Strom, the decoder keeps frames
  in CUDA memory and `autovideoconvert` inside `builtin.videoenc` turns them into GLMemory that
  `nvh264enc` won't encode, so the file ends up audio-only (#569, Eyevinn/strom#1104). Trade-off:
  the constraint reaches the decoder through the tee, so a recorded input's mixer branch also gets
  system memory (the GPU mixer uploads it again); inputs that are not recorded keep GPU memory.
  Drop the capsfilter once strom#1104 makes `videoenc` accept CUDA input itself.
- An audio-only guest or a camera without sound: Live Recorder releases a connected track that
  carries nothing for 20 s and starts the file without it (strom#1034 "Late tracks"), so one
  two-track recorder still records the other track. A track that stops later leaves a gap in the
  same file. See Risk R5 for the late-video case.
- Block ids are keyed by the **stored** pad index (like `b-offset-N`), never the compacted one.

### 4.4 Flow layout example

Program + `video_in_1` (SRT) + `video_in_15` (WHIP guest), both recorded, Live Recorder path:

```
b-input-1  ─video_out─┬─> b-offset-1 ─> mixer:video_in_0
                      └─> e-inrec-vq-1 ─> b-inrec-venc-1 ─> b-inrec-1 (recordings/<pid>/video_in_1)
           ─audio_out_0┬─> b-audio-offset-1 ─> mixers
                      └─> e-inrec-aq-1 ───────────────────> b-inrec-1
b-input-15 ─video_out─┬─> b-offset-15 ─> mixer:video_in_1
                      └─> … b-inrec-15 (recordings/<pid>/video_in_15)
Enc PGM ───────────────> b-out-<id> builtin.liverecorder (recordings/<pid>)
mixer main_out ────────> b-out-<id>:audio_in_0
```

---

## 5. Files, upload and registration

### 5.1 Strom directory layout (Q5)

```
recordings/<productionId>/                          program: <productionId>_<YYYYmmdd_HHMMSS>_<nnnnn>.mp4
recordings/<productionId>/<mixerInput>/             input:   <productionId>_<mixerInput>_<YYYYmmdd_HHMMSS>_<nnnnn>.mp4
```

The file-name grammar is unchanged, so `parsePartName`, `comparePartNames` and
`recordingStartFromFileName` work as they are. The `<mixerInput>` in the prefix makes a downloaded
file self-describing.

### 5.2 Object keys

```
[RECORDING_KEY_PREFIX/]<productionId>/<fileName>                  program (unchanged)
[RECORDING_KEY_PREFIX/]<productionId>/<mixerInput>/<fileName>     input
```

`recordingObjectKey(productionId, fileName)` (`recording-uploader.ts:713`) gains an optional
`mixerInput`. Same bucket/connection as program (the activation's `recording` snapshot).

### 5.3 Live part upload (#566), generalised to one session per recorder

`services/live-recording-upload.ts` today keeps one `LiveRecording` per production. It becomes one
per **recorder** (program + each input), grouped by production:

- `startLiveRecordingUpload(doc, log)` starts a session for `doc.recorderBlockId` and one per
  `doc.inputRecordings[]`. `resumeLiveRecordingUploads` does the same after a restart.
- `stopLiveRecordingUpload(productionId)` stops and awaits **all** sessions of the production,
  returning a per-directory `LiveRecordingSession` (`activationId`, `stem`, and the new
  `openedAt` map, §6).
- **File-to-session matching must be by exact directory.** Today a file is attributed when
  `event.filename.startsWith('<outputDir>/')` (`live-recording-upload.ts:178`). With input
  directories nested under the program's, every input event would match the program session too,
  move its `openFile` to an input stem, and make the program's open part look closed. Match
  `dirname(event.filename)` (after stripping any media-root prefix Strom adds) **equal to**
  `outputDir`, or `event.blockId === recorderBlockId`. Add a regression test with nested dirs.
- The subscription to the shared recorder-event socket (`services/strom-recorder-events.ts`) is
  kept even when `RECORDING_SEGMENT_SECS=0`, because it records each file's open time (§6); only
  the upload passes are skipped in that case.
- Stability rule, size check, idempotent `upsertRecordingDoc`, delete-after-register and
  "never touch the newest file" are unchanged and apply per directory.

### 5.4 Deactivate

| Recorder type | Order |
|---|---|
| `recorder` (fallback) | unchanged: stop live sessions → `splitNow` → upload program dir → `deactivateStromFlow` |
| `liverecorder` | stop live sessions → `strom.flows.stop` (Live Recorder finishes every open file inside the stop, ≤3 s per recorder, strom#1034 "Stop") → upload **each input dir, then the program dir** → `deactivateStromFlow` (its second stop is a no-op) |

- No `splitNow` on the Live Recorder path (reconciles #489 1c71eb5 with #566): after the stop
  every file is closed, so the deactivate sweep uploads them all, and the live session's
  "newest file is open" rule no longer applies — the sweep is told the flow is stopped.
- Inputs before program because `uploadRecordings` deletes `recordings/<pid>` only when it is
  empty (`recording-uploader.ts:829-834`); the program dir is empty only after its input
  subdirectories are gone. Each input dir is deleted by its own sweep.
- `uploadRecordings` lists one directory non-recursively and skips `is_dir` entries
  (`recording-uploader.ts:788`), so the program sweep never uploads an input file under a program key.
- `lastRecordingUpload` (`RecordingUploadSummary`) totals program and inputs; `failed[]` names the
  file path, which includes `<mixerInput>`.
- The idle watchdog keeps its current behaviour (stop sessions, no upload,
  `services/idle-watchdog.ts:253`); leftovers are swept by the next deactivate, per directory.
  The leftover sweep covers every `<mixerInput>` subdirectory that exists, not only the ones
  this activation recorded.

---

## 6. Start times and alignment (AC 3)

Each part's `startedAt` is taken from the first available source, and `startedAtSource` records
which one was used. The base order is 1 → 2 → 3 → 4; on Live Recorder a part after a split takes
rule 3 ahead of rule 2 (see "Parts after a split" below):

| # | `startedAtSource` | Source | Precision | Available |
|---|---|---|---|---|
| 1 | `strom` | `RecorderFileChanged.start_utc_us` — the file's t=0 on the flow's UTC anchor | < 1 ms between files of one flow (strom#1057 tests) | only once strom#1057 merges and is deployed. Already parsed by `strom-recorder-events.ts:75-84`; no code change when it lands |
| 2 | `event` | wall-clock time open-live **received** `RecorderFileChanged` for that file | 50-80 ms late when the first file opens (measured on #411's rig against a two-track reference); **3-5 s late at a Live Recorder split** (#569 acceptance run, #575) | today, whenever open-live is connected to the event socket when the file opens |
| 3 | `chained` | previous part of the same recorder and stem: its `startedAt + durationMs` | carries the predecessor's error; fMP4 durations are exact | a part opened while open-live was disconnected, after a part with a known start; on Live Recorder, every part after a split whose chain is anchored on rule 1 or 2 |
| 4 | `filename` | today's rule: name stamp + summed earlier durations (`recordingPartTimings`) | ≥1 s (second-truncated block-build time, Strom local zone) — and wrong for late-joining WHIP inputs | last resort |

`endedAt = startedAt + durationMs` when the duration is known (§7), else upload time, as today.

**Parts after a split (#575).** At a Live Recorder split, `RecorderFileChanged` for the new file
reaches open-live seconds after the file's t=0 (3.1 s program, 3.0 s SRT input, 4.9 s WHIP input in
the #569 run), by a different amount per recorder, so rule 2 misaligns inputs from program. Live
Recorder's parts are gapless, so for a part with index > 0 on `recorderType: liverecorder` the
order is **1 → 3 → 2 → 4**: rule 3 applies when the predecessor's duration is known and its start
is anchored on rule 1 or 2 (directly, or through a chain of rule-3 parts). A chain anchored on
rule 4 is not taken ahead of rule 2, so a name-stamp error (≥ 1 s, or the Strom-local-zone hour)
is not carried forward. `endedAt` follows from the chained start, so it no longer lands after the
part was registered. `builtin.recorder` keeps 1 → 2 → 3 → 4: #571 measured up to 1.9 s not
accounted for by part durations at its first split, so its parts are not gapless. The first part
of every recorder is unchanged (rule 1, else 2, else 4). Once strom#1057 is deployed, rule 1
takes over for every part and this reorder no longer applies.

**AC 3 without strom#1057:** the first parts of program and input recorders of one activation are
all stamped by rule 2 (same open-live process, same clock, same socket), so the worst-case skew
between any two first files is the spread of event delivery delays: tens of ms, well inside 1 s
(+0.17 s measured on #569). On Live Recorder every later part chains from those starts by exact
fMP4 durations, so it keeps that skew (all three recorders ended within 0.2 s of each other in the
#569 run). Rule 3 also keeps it inside 1 s after a reconnect. Only rule 4 can miss, and only when open-live saw no event for the first part of a
recorder (it was down when the file opened); `startedAtSource: "filename"` tells a consumer so.
**With strom#1057**, rule 1 makes alignment exact and nothing else changes.

The open-time index lives in the live session (`Map<filename, { openedAtMs, startUtcUs? }>`) and
is handed to the deactivate sweep in `LiveRecordingSession`, so the last part (registered at
deactivate) gets rule 1/2 too. Program uses the same rules on both recorder types.

---

## 7. Duration of fragmented MP4 parts (AC 7)

`Mp4DurationScanner` gains a third fallback after `mvhd` and `mehd`: sum the sample durations of
the `moof/traf/trun` boxes it streams past (sample duration from `trun` when flag `0x100` is set,
else `tfhd` default-sample-duration, else `trex` default from `moov/mvex`), per track, in the
track's `mdhd` timescale, and return the longest track. `mdat` payloads are skipped, not buffered
(#552 rule: never hold a file whole). Own code (a few dozen lines on top of the existing box
walker); no dependency. Covered by a unit test on a fragment fixture written by Live Recorder.

---

## 8. Studio contract (#233 builds on exactly this)

| Need (#233) | Contract |
|---|---|
| Record toggle per source | `PUT /api/v1/productions/{id}/sources/{mixerInput}/record` `{ record: "off" \| "transcode" }` (§2.3); current value is `record` on `production.sources[]` (absent = off) |
| "Applies from next activation" note | `appliesFrom: "next-activation"` in the PUT response; `currentlyRecording` says whether the running activation records it |
| Warning with no recording output, before activation | `recordingOutputAssigned: false` in the PUT response; at activation the `input-recording-no-output` warning (WS `ERROR`, `activationWarnings`) |
| Other refusals | 400 `record-source-unsupported` (test/HTML/clip sources: hide or disable the toggle for those), 400 `record-mode-unsupported`, 409 `record-cap-reached` (show `error`) |
| Recording indicator per tile while live | WS `RECORDING_STATE.inputs[].mixerInput` (stored key), also `production.inputRecordings[]` |
| Recordings tab grouped by activation | `activationId` on every asset; `kind: "program" \| "input"`; list is sorted (§2.4) |
| Labels | `sourceName` (multiviewer label at activation), `guestLabel` / `guests[]` for WHIP guests |
| Filter by input | `GET …/recordings?mixerInput=video_in_2` (or `sourceId=`), `kind=`, `activationId=` |
| Play / download / delete | unchanged: `playbackUrl`, `downloadUrl`, `DELETE /api/v1/recordings/{id}` |
| Strom without Live Recorder | `input-recording-unavailable` warning; program still records |

A production that records no inputs returns exactly the shapes it returns today plus
`kind: "program"` on its recordings (#233 AC 4).

---

## 9. Service interactions

```mermaid
sequenceDiagram
    autonumber
    participant ST as Studio (open-live-studio)
    participant OL as open-live API
    participant DB as CouchDB
    participant SR as Strom
    participant EV as Strom event WS (shared, strom-recorder-events)
    participant S3 as Object storage (connection of the recording output)

    ST->>OL: PUT /productions/{id}/sources/video_in_2/record {record:"transcode"}
    OL->>DB: get production, check source type + RECORDING_MAX_INPUTS
    OL->>DB: write sources[video_in_2].record = "transcode"
    OL-->>ST: 200 {appliesFrom:"next-activation", recordingOutputAssigned}

    ST->>OL: POST /productions/{id}/activate
    OL-->>ST: 200 {status:"activating"}
    OL->>SR: GET /api/blocks (has builtin.liverecorder?)
    alt Live Recorder present (and RECORDING_BLOCK=auto)
        OL->>SR: create + start flow: program liverecorder + one liverecorder per recorded input (tap before time_offset)
    else no Live Recorder / list unreadable
        OL->>SR: create + start flow: program builtin.recorder only (as today)
        OL->>OL: warning input-recording-unavailable (only if inputs asked to record)
    end
    OL->>DB: recorderBlockId, recorderType, recording snapshot, inputRecordings, activationWarnings
    OL->>EV: subscribe one session per recorder
    OL-->>ST: WS ERROR (warnings), RECORDING_STATE {program, inputs}

    loop every RECORDING_SEGMENT_SECS per recorder
        SR-)EV: RecorderFileChanged {flow_id, block_id, filename[, start_utc_us]}
        EV-)OL: dispatch to the session whose outputDir == dirname(filename)
        OL->>OL: record openedAt (rule 2) / start_utc_us (rule 1)
        OL->>SR: GET media list of that dir; wait PART_STABLE_MS; re-list
        OL->>SR: download closed part (stream)
        OL->>S3: upload to <pid>/[<mixerInput>/]<file>
        OL->>DB: upsert RecordingDoc by bucket+key (kind, mixerInput, sourceId, sourceName, guests, startedAt)
        OL->>SR: delete part
    end

    ST->>OL: POST /productions/{id}/deactivate
    OL-->>ST: WS RECORDING_STATE {program:false, inputs:[]}
    OL->>OL: stop + await all live sessions (collect openedAt maps)
    alt recorderType = liverecorder
        OL->>SR: POST flow stop (Live Recorder finalises open files)
        loop each input dir, then program dir
            OL->>SR: list + download every file
            OL->>S3: upload
            OL->>DB: upsert RecordingDoc
            OL->>SR: delete file, delete dir when empty
        end
    else recorderType = recorder
        OL->>SR: recorder split-now, then upload program dir (as today)
    end
    OL->>SR: stop (no-op) + delete flow
    OL->>DB: deactivated doc (clear recorderType, inputRecordings), lastRecordingUpload

    ST->>OL: GET /recordings?productionId=…&activationId=…
    OL->>DB: find (guarded equality selector)
    OL-->>ST: RecordingAsset[] with presigned playbackUrl/downloadUrl
```

---

## 10. Configuration

### 10.1 Environment variables (`src/config.ts`, existing parse helpers)

| Env var | Default | Range | Purpose |
|---|---|---|---|
| `RECORDING_MAX_INPUTS` | `4` | integer 0-16 | Max inputs with `record` on per production. `0` disables input recording (every enable returns 409 `record-cap-reached`). Provisional — revisited by the load-measurement ticket (Q3). |
| `RECORDING_INPUT_VIDEO_BITRATE_KBPS` | `4000` | integer 500-50000 | `bitrate` of each input recorder's `builtin.videoenc` |
| `RECORDING_BLOCK` | `auto` | `auto` \| `recorder` | `auto`: Live Recorder when Strom has it, else `builtin.recorder`. `recorder`: always `builtin.recorder` for program and no input recording — an operator escape hatch if Live Recorder misbehaves in production, without a rollback. |
| `RECORDING_SEGMENT_SECS` | `600` (unchanged) | 0-86400 | Now applies to input recorders too |
| `RECORDING_KEY_PREFIX` | `""` (unchanged) | | Prefix for program and input keys |

An invalid value fails startup with the existing config error, like the other recording vars.
None of these is secret. Add them to the env table in `docs/specs/vod-recording-minio.md` and the
README/OSC config docs.

### 10.2 Strom

- Requires nothing new from Strom. Live Recorder is present from Strom v0.7.0; detection is by
  block list, so any build that has the block works and older ones fall back.
- Disk on the Strom host: each recorded input adds roughly
  `RECORDING_INPUT_VIDEO_BITRATE_KBPS` + ~128 kbit/s of AAC ≈ 1.9 GB/h at the default, held until
  each part uploads (`RECORDING_SEGMENT_SECS` + stability wait, or until deactivate with
  `RECORDING_SEGMENT_SECS=0`).

---

## 11. Dependencies (CTO rule, 2026-10-22)

No new dependency, runtime or dev.

1. Needed: block-type detection, flow JSON, fMP4 duration, directory-aware session matching,
   timing precedence. All are small own code on top of existing modules (`strom.blocks.list`,
   `Mp4DurationScanner`, `live-recording-upload.ts`, `recording-parts.ts`).
2. Not applicable (no library considered). An MP4 parsing library (e.g. `mp4box`) was rejected for
   §7: we need one number from three box types, and the existing walker already parses ISO BMFF
   headers from untrusted bytes with bounds checks — adding a large parser of untrusted input is
   the larger supply-chain and attack surface.
3. Existing imports touched: none added or removed.

`/health` and `/ready`: no new service, so no new endpoints.

---

## 12. Open questions — with the team's recommended resolution

Every question below has a recommended answer the team can adopt without a human; none blocks
implementation. Flag to team-lead at the Phase 1 gate.

**Q0. Recorder or Live Recorder?** → **Live Recorder (`builtin.liverecorder`) for program and
inputs whenever Strom has it**, detected per activation from the block list; program moves to it
in the same ticket (scope note). **Fallback** when the block is missing, the list is unreadable, or
`RECORDING_BLOCK=recorder`: program keeps `builtin.recorder` exactly as today (incl. split-now and
`recording-no-audio`), input recording is refused with `input-recording-unavailable`. Unlike #489,
program recording is never dropped. Reasoning and alternatives: ADR-011.

**Q0a. Does the fallback warn when no input asks to record?** → **No.** The warning is raised only
when ≥1 assignment has `record: "transcode"`, so a production that records no inputs behaves
exactly as before on every Strom (AC 4). AC 8's "activation reports a warning that input recording
is unavailable" is satisfied in the scenario it describes (inputs requested on an old Strom).

**Q1. Does input recording need a `recording` output?** → **Yes.** The output picks the storage
connection, and the activation's `recording` snapshot is shared by program and inputs. The
setting itself is accepted without one (operators assign outputs and sources in any order); the
PUT response returns `recordingOutputAssigned: false` and the activation raises
`input-recording-no-output` and builds no input recorders (AC 5). Recording inputs without a
program recording is not offered in v1.

**Q2. Can `record` change while live?** → **No, not in v1.** It is read at activation, like the
high-pass-filter on/off flag. The PUT response always carries `appliesFrom: "next-activation"` and
`currentlyRecording`; Studio says so next to the toggle. A live change would add/remove branches on
a running tee and is a separate feature if asked for.

**Q3. Cap on recorded inputs per production?** → **`RECORDING_MAX_INPUTS`, default 4, range 0-16,
env-configurable.** Enforced at set time (409 `record-cap-reached`) and at activation (first N by
numeric stored pad index, `input-recording-capped` for the rest). Why 4: each recorded input adds
one H.264 encode on the shared GPU on top of the production's three (`Enc PGM`, `Enc MV`,
`Enc View`), and 4 inputs + program is the smallest useful ISO set (a 3-4 camera show) while
staying within a doubling of today's encoder count. **To be revisited** by ticket 3 (§13), which
measures Strom load with 0, 4 and 8 recorded inputs on the shared GPU and either confirms 4 or
changes the default, recording the numbers in this spec.

**Q4. What happens to #411, #426, #427 (and #489)?** → **Close #411 and #489 as superseded** when
ticket 2 merges, with a comment crediting @wagenet and linking this spec; post the same note on
#410 and close it with ticket 2. **Close #426 and #427 as not planned** at the same time: the code
they fix (`services/recording-index.ts`) never reaches main. Their lessons are already carried: the
production delete route stops recorder sessions (`routes/productions.ts`, `stopLiveRecordingUpload`
before teardown — #426's point), and there is no per-production socket or open-wait to block
activation (shared `strom-recorder-events.ts` — #427's point). Asking on #410 first is not needed:
the PM decided on #569 to build in-house on the current recording path.
What carries over from #411/#489, explicitly:
- **Kept:** the `record` enum shape (`'off' | 'transcode'`, `passthrough` reserved and refused
  with 400, so passthrough can be added later without a breaking change); tap before
  `time_offset`; leaky queue before the encoder; `builtin.videoenc` H.264 with a 60-frame GOP;
  Live Recorder properties and pads; the "warn, don't fail the flow" rule on a Strom without the
  block; no split-before-stop on Live Recorder.
- **Dropped:** the `recordings.json` sidecar (the `RecordingDoc` + API is the single, documented
  contract; a second, file-based source of truth would have to be kept consistent with it. A TAMS
  writer, when it comes, reads the API or gets its own spec); the per-activation directory
  (`activationId` on each doc does that job, and the flat layout keeps the #566 sweep per
  directory); separate video/audio recorders and files per input (Live Recorder makes one A/V file
  per input possible, which is what an editor wants — ADR-011 Decision 3); the `track` field.

**Q5. File layout?** → **`recordings/<productionId>/<mixerInput>/`**, file prefix
`<productionId>_<mixerInput>`, object key `<productionId>/<mixerInput>/<file>` (§5). Requires
exact-directory matching of recorder events (§5.3) and input-dirs-before-program-dir deletion
(§5.4).

**Q6. Which source types can be recorded?** → **WHIP, SRT and EFP only** in v1 (arriving feeds, as
#410 asked). Test patterns, HTML and clips are generated or already files; enabling them returns
400 `record-source-unsupported`, and a source edited into an unsupported type after the setting is
skipped at activation with `input-recording-unsupported-source`.

**Q7. One file per input, or one per track?** → **One file per input, video + audio.** Live
Recorder does not stall on a quiet track and releases a track that never starts (strom#1034), so
the reason #411 split tracks (`builtin.recorder` waits for both) is gone; the Strom maintainers
rejected per-track recorders for the same reason ("the operator wants one file with A/V sync").

**Q8. How is AC 3 (alignment within 1 s) met while strom#1057 is open?** → By rule 2 of §6
(event receipt time), tens of ms, for each recorder's first part, and on Live Recorder by rule 3
(chained by exact durations) for the parts after a split (#575), with `startedAtSource` on every doc. When strom#1057 ships, rule
1 takes over automatically. No ticket waits on it.

---

## 13. Implementation plan (follow-up tickets, in order)

Each ticket is machine-completable (architect "Machine-completable tickets"); verification on the
dev instance is done by the agent in the ticket. No human ticket.

1. **OL-32a — Program recording through Live Recorder, with `builtin.recorder` fallback**
   (`Eyevinn/open-live`, backend). Depends on: this spec.
   - Block selection §4.1 incl. `RECORDING_BLOCK`; program block §4.2; `recorderType` on
     `ProductionDoc`/`RecordingDoc`.
   - Deactivate order §5.4 for Live Recorder (no split-now); fallback path untouched.
   - Start-time precedence §6 for program (session keeps open times even with
     `RECORDING_SEGMENT_SECS=0`); `startedAtSource`.
   - fMP4 duration §7.
   - Exact-directory event matching §5.3 (needed before ticket 2 nests directories; harmless now).
   - `kind` field + `migration:recording-kind-v1` §3.4.
   - Tests: block choice on present/absent/unreadable block list and `RECORDING_BLOCK=recorder`;
     Live Recorder program flow JSON; no split-now on the Live Recorder path; fMP4 duration fixture;
     timing precedence; migration idempotence.
   - Agent-run verification on the dev Strom: record ≥35 min with `RECORDING_SEGMENT_SECS=300`;
     every part uploaded while live without gaps (AC 9), plays, `durationMs` set (AC 7);
     on a Strom without the block (or `RECORDING_BLOCK=recorder`) program records as before (AC 8).
   - Covers AC 7, 8, 9.
2. **OL-32 — Per-source input recorders, metadata, API/WS, docs** (`Eyevinn/open-live`).
   Depends on: ticket 1.
   - `record` on assignments, POST change §2.2, PUT route §2.3, cap and source-type checks.
   - Input recorder wiring §4.3, `inputRecordings`, the four warnings §2.7.
   - One live session per recorder, key layout, per-dir deactivate sweep §5.
   - `RecordingDoc` metadata §3.1 incl. `guests`/`guestLabel`; listing filters + sort §2.4;
     `RECORDING_STATE` §2.8.
   - Docs: `docs/openapi.yaml`, `docs/controller-websocket.md`, `docs/specs/vod-recording-minio.md`
     (env table, layout), `docs/repo-patterns.md` (exact-dir matching; input dirs before program dir).
   - Tests (#569 item 7): default off; one recorder per recorded input and none otherwise; taps
     before `time_offset`; upload + idempotent registration of input parts; metadata; filters;
     each warning; cap; deactivate uploads the last open part of every input (AC 6).
   - Agent-run verification on the dev instance: AC 1-6 with two recorded inputs (one SRT test
     feed, one WHIP guest from join-live) for 10 min at `RECORDING_SEGMENT_SECS=300`, checking with
     `ffprobe` that each input file has picture and sound and that program/input `startedAt` of one
     activation are within 1 s.
   - Closing actions: close #411, #489, #410 as superseded and #426, #427 as not planned (Q4).
   - Covers AC 1-6.
3. **OL-32c — Load measurement and cap** (`Eyevinn/open-live`, agent-run). Depends on: ticket 2.
   - On the shared-GPU dev Strom, one production with program recording and 0, 4 and 8 recorded
     inputs (SRT test feeds), 15 min each: Strom CPU, GPU encoder utilisation and session count,
     leaky-queue drops in the recordings, program end-to-end latency, `flows.stop` time.
   - Update `RECORDING_MAX_INPUTS` default if the numbers say so; write the table into §12 Q3 of
     this spec and the env docs.
   - Capability the runner needs: the dev instance's Strom URL/token and an SRT test source
     (`open-live-ingest` or Strom test source). If the runner lacks GPU metrics access on the dev
     Strom host, the ticket records Strom-side `/api` stats only and says which metric is missing.
4. **OL-32b — Studio** ([open-live-studio#233](https://github.com/Eyevinn/open-live-studio/issues/233)).
   Starts when ticket 2 is merged and deployed to staging (epic-workflow Phase 3); uses §8 only.

strom#1057 needs no ticket on our side (§6 rule 1 is already parsed).

**What a human does next (after ticket 2 closes):** turn on Record for two inputs on a production
with a recording output, go live for ten minutes, and check the Recordings tab lists program and
both inputs per activation, each playing with picture and sound. Expected result: as AC 1-3.

---

## 14. Risks

| # | Risk | Mitigation / detection |
|---|---|---|
| R1 | **Nested input dirs break program part detection** (`startsWith` match, `live-recording-upload.ts:178`): the program's open part is treated as closed. | Exact-dir match §5.3, landed in ticket 1 before nesting exists; regression test with nested events. |
| R2 | **Program dir never deleted** because input subdirs remain. | Inputs swept before program §5.4; leftover sweep visits every subdir. |
| R3 | **Live Recorder parts list without duration** (fMP4, no `mehd`), so AC 7 fails and part timings fall back to `RECORDING_SEGMENT_SECS`. | §7 fragment summing; fixture test. |
| R4 | **GPU/encoder load**: N extra H.264 encodes on the shared GPU; consumer NVIDIA cards cap concurrent NVENC sessions, after which `builtin.videoenc` falls back to software or fails. | Default cap 4; ticket 3 measures 4 and 8; the leaky queue protects program from a slow recorder. |
| R5 | **Late video on a WHIP guest**: Live Recorder releases a track that carries nothing for 20 s and the muxer takes no pads after it starts, so a guest whose video arrives >20 s after audio may be audio-only until the next part. | Accept for v1 (rare; strom#1034 saw 7-9 s). Ticket 2's WHIP verification checks the normal case; if seen, file a Strom issue rather than work around it here. |
| R6 | **Strom disk** fills faster (≈1.9 GB/h per input at default), worst with `RECORDING_SEGMENT_SECS=0`. | Live upload deletes parts as they close; document the figure (§10.2). |
| R7 | **Listing limit 500** is reached sooner with ISO parts (5 recorders × 6 parts/h = 30 docs/h per production); Mango without a sort returns an arbitrary 500. | Filters let Studio query per production/activation; pagination is a separate follow-up issue if the limit is hit (not v1). |
| R8 | **Rule-4 start times** (`filename`) are ≥1 s off when open-live missed a recorder's first event. | `startedAtSource` exposes it; resume after restart subscribes before Strom opens the next part. |
| R9 | **fMP4 in editors**: some NLEs import fragmented MP4 less reliably than progressive MP4. | AC 7 verification opens a part in an editor/`ffprobe`; if an editor refuses, a remux-on-upload option is a follow-up, not v1. |
| R10 | **Live Recorder regressions in production** (new block, "experimental" in strom#1034). | `RECORDING_BLOCK=recorder` switches back without a deploy of code; detection fails safe to `builtin.recorder`. |
| R11 | **POST /sources replace semantics** silently turn recording off when a client reassigns without `record`. | Documented; Studio uses the PUT route; OpenAPI says so. |
