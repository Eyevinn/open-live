# ADR-006: Audio-stream selection is persisted per-source on `SourceDoc` as a 0-based index, applied in the pipeline via a Strom input-block selector, with the stream list discovered at read time (never persisted)

**Date**: 2026-10-15
**Status**: Proposed

> Companion spec: [`docs/specs/audio-stream-selection.md`](../specs/audio-stream-selection.md).
> Issue: [Eyevinn/open-live#511](https://github.com/Eyevinn/open-live/issues/511).
> This ADR settles the two significant design choices of #511: **where the selection lives**
> and **how available streams are discovered**. It does not settle spec Open Question 4
> (stream-level vs channel-level), which is a product decision escalated to @svensson00.

## Context

An MPEG-TS-over-SRT (or EFP/SRT) input can carry several audio elementary streams, but Open
Live always uses the first one and the choice is hard-wired, not operator-visible. Issue #511
(split from #508) asks to make the audio stream a first-class, operator-chosen value, with the
default staying the first stream.

Constraints and facts established from the code:

- A source is `SourceDoc` (`src/db/types.ts:161-199`); its only SRT/EFP decode parameters are
  `address` (`:166`) and `latency?` (`:170-171`). There is **no** audio-stream field. The
  alternative home for a per-production choice is `ProductionSourceAssignment`
  (`src/db/types.ts:556-569`), whose optional `returnFeed?` is the precedent for a
  per-assignment config object.
- The flow generator builds one `builtin.mpegtssrt_input` / `builtin.efpsrt_input` block **per
  source**, from `source.address` + `source.latency` only (`src/lib/flow-generator.ts:870-879`),
  and wires a single hard-coded `audio_out_0` pad into the audio path
  (`src/lib/flow-generator.ts:892-895`).
- That input block exposes **only** `srt_uri`, `latency`, and one `audio_out_0` pad
  (`docs/strom-block-config.md:50-58`). There is no property or pad for selecting among
  multiple audio streams — confirmed, nothing in `src/` references `audio_stream`/`audio_pid`/
  `audio_out_1`. The standing rule is that the live `GET /api/blocks` `exposed_properties` is
  authoritative and pipeline shapes must never be invented (`docs/strom-block-config.md` header,
  Agent Rule 9).
- There is **no stream-probing / metadata-discovery facility** anywhere in the backend (no
  ffprobe, no SRT stream metadata read).
- Recent `SourceDoc` fields (`gatewayId?` `:192-196`, `auth?` `:170-181`) were all added as
  additive-optional with no migration; a heavier one-time rewrite path exists
  (`src/services/migrate-audio-channel-order.ts`) only for fields that must be back-filled.
- `src/lib/audio-channels.ts:49-52` hard-assumes exactly one audio stream per source for mixer
  channel numbering.

## Decision

1. **The selection is persisted per-source as `SourceDoc.audioStreamIndex?: number`** — an
   optional 0-based index, added additively with **no CouchDB migration** (absent ⇒ index 0,
   today's behaviour). It is a decode parameter of the feed, in the same category as `latency`
   and `address`, which already live on `SourceDoc` and nowhere else; the block that consumes
   it is built per-source in the flow generator, so the value flows straight from `SourceDoc`
   to the pipeline with no new plumbing. A per-production override on
   `ProductionSourceAssignment` is a deliberate future extension (resolution would be
   `assignment ?? source ?? 0`), **out of scope for v1**.

2. **It is read/written through the existing sources resource**: surfaced on `toApi()` via the
   existing `...rest` spread (`src/routes/sources.ts:235-238`), written via the existing
   `PATCH /api/v1/sources/:id` and `POST /api/v1/sources` with one new zod field
   (`audioStreamIndex: z.number().int().min(0).optional()`), rejected (400) on a non-SRT/EFP
   source. It is a **non-live** property (like `latency`): changing it on an in-use source is
   accepted and applied on the next (re)activation — **no** 409-on-air guard (that guard is for
   auth material only, `src/routes/sources.ts:210-218,442`).

3. **The available-stream list is discovered at read time and never persisted**, via a new
   read-only `GET /api/v1/sources/:id/audio-streams` sub-resource that returns the live stream
   list plus the current `selectedIndex`. Deriving it at read time means it can never go stale
   against the real feed.

4. **In the pipeline, selection is applied via a Strom input-block selector property**
   (recommended: a scalar `audio_stream_index` on `builtin.mpegtssrt_input` /
   `builtin.efpsrt_input`, default 0, emitting the chosen stream on the existing `audio_out_0`
   pad), set at `src/lib/flow-generator.ts:874-877` alongside `latency`. An out-of-range or
   absent index is **clamped to 0** at build time; the flow is never failed over a stale index.

5. **This feature is gated on an upstream Strom capability that does not exist yet** (§Context):
   neither a selector property nor multi-audio pads are present on the input block today. A
   Strom issue must be filed and the exact property/pad name confirmed against live
   `GET /api/blocks` before any Phase 2 backend wiring. Until it lands, the backend field and
   discovery endpoint still ship (discovery returns `unavailable`), so Open Live degrades to
   "stream 0 only" without breaking the contract.

## Consequences

**Positive**:
- Minimal, additive data model — one optional `SourceDoc` field, no migration, no new env var;
  every existing source stays valid unchanged (mirrors `latency?`/`gatewayId?`).
- The value reaches the pipeline through the existing per-source block build, so no new
  cross-service plumbing (production/assignment layer untouched).
- Read-time-derived stream discovery can never be stale; the API contract is stable across the
  Strom capability landing (the field and endpoint ship now, degrade gracefully).
- Read/write reuse the hardened sources route (zod validation, `toApi`, error-code
  conventions) — almost no new surface area.

**Negative**:
- A source reused across productions shares one selection; divergent per-show choices need the
  deferred per-assignment override (acceptable for v1).
- The feature is **not usable end-to-end until Strom ships the selector/pads** — the backend
  and UI are "ready but inert" until then.
- Stream-level only: a single stereo stream carrying multiple channel pairs cannot be split in
  v1 (see Alternatives + spec Open Question 4).

**Risks**:
- **Upstream Strom gap (primary).** No selection primitive exists on the input block today.
  *Detection/mitigation*: gate Phase 2 on a tracked Strom issue + a name confirmed against live
  `GET /api/blocks`; ship the Open Live contract with a graceful `unavailable`/clamp-to-0
  fallback so nothing breaks before Strom lands.
- **Silent wrong/lost audio** from a persisted index that no longer matches the live feed.
  *Detection/mitigation*: clamp to 0 + a non-fatal warning surfaced via the discovery endpoint;
  never hard-fail activation.
- **Invented pipeline shape** drifting from Strom reality. *Mitigation*: confirm against runtime
  `exposed_properties`; flag drift (standing rule).

## Alternatives Considered

- **Persist the selection per-production on `ProductionSourceAssignment` (per-input-use).**
  *Rejected for v1.* More flexible (same feed, different stream per show) but it is not where
  the other decode parameters live, it forces the value through the production/assignment layer
  and a new fan-out into the flow generator, and no concrete need was identified. Kept as a
  clean future extension (`assignment ?? source ?? 0`), not precluded.
- **Persist the discovered stream list on the source doc.** *Rejected.* The real stream layout
  is a property of the live feed, not stored config; persisting it creates a second source of
  truth that goes stale on any feed change — the same read-time-derive argument as the SRT
  connect-address spec (`docs/specs/srt-output-address.md` §3).
- **Multiple `audio_out_N` pads on the input block (Strom Option B) instead of a selector
  property.** *Not chosen as the recommendation* (kept as a fallback). More flexible — enables
  routing several audio streams simultaneously later — but a larger pipeline-shape change,
  needs the pad count known at build time, and is more than #511 requires. A scalar
  `audio_stream_index` property matches how `latency` is already a scalar block property and is
  strictly less change at `flow-generator.ts:874-892`.
- **Reject an out-of-range index at write time (strict validation).** *Rejected.* The
  authoritative stream count is not known at write time (no probe; the feed may not be live),
  so strict write-time validation is impossible without coupling the write path to a live flow.
  Validate/surface at discovery + activation instead, and clamp to 0 at build.
- **Add a 409-on-air guard for `audioStreamIndex` changes.** *Rejected for v1.* It is a
  non-live property like `latency`/`address`, neither of which is guarded; a change simply
  applies on reactivation. A future live-switch capability could revisit this.
- **Channel-level (intra-stream channel-pair) selection in v1.** *Deferred — product decision.*
  It would break the one-audio-stream-per-channel invariant
  (`src/lib/audio-channels.ts:49-52`), require `audioStreamIndex` to become a
  `{ streamIndex, channelPair }` object, and needs a Strom channel-routing primitive. Escalated
  to @svensson00 as spec Open Question 4; v1 is stream-level unless that confirms otherwise.
