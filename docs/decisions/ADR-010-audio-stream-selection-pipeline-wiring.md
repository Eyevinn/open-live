# ADR-010: Audio-stream selection is applied by wiring `audio_out_<index>` of a multi-output `builtin.mpegtssrt_input` (PID-ordered upstream), MPEG-TS/SRT only in v1, clamped to the first stream with an input-scoped Studio warning

**Date**: 2026-10-17
**Status**: Accepted (2026-10-27). The upstream capability shipped as
[Eyevinn/strom#1081](https://github.com/Eyevinn/strom/issues/1081) (PR
[Eyevinn/strom#1120](https://github.com/Eyevinn/strom/pull/1120), `dc2d228`, first released in
Strom `v0.8.0-alpha.1`): the opt-in Bool property `map_audio_by_pid` on
`builtin.mpegtssrt_input` maps `audio_out_k` to the k-th audio stream in ascending PID order,
falls back in-block to the first stream when the k-th is missing, and is the capability signal
Open Live detects in `GET /api/blocks` (Decision 2c). Implemented in
[Eyevinn/open-live#545](https://github.com/Eyevinn/open-live/issues/545). Because the
property is opt-in, Decision 1's "no new property" is amended: the k > 0 shape also sets
`map_audio_by_pid: true`. The runtime `stream-not-present` signal (Decision 4) is not yet
exposed through Strom's flows API and is a follow-up.

> Supersedes **Decisions 4 and 5** of
> [ADR-006](ADR-006-audio-stream-selection.md). ADR-006 Decisions 1–3 (persist
> `SourceDoc.audioStreamIndex`, read/write through the sources resource, read-time discovery
> endpoint) stand unchanged and are implemented (PR #518, issue #515).
> Companion spec: [`docs/specs/audio-stream-selection.md`](../specs/audio-stream-selection.md)
> (revised 2026-10-17, §5.3, §5.4, §6, §8).
> Issue: [Eyevinn/open-live#516](https://github.com/Eyevinn/open-live/issues/516).

## Context

ADR-006 Decision 4 recommended a new scalar selector property (`audio_stream_index`) on the
Strom input block that would emit the chosen stream on the existing `audio_out_0` pad, and
Decision 5 said "neither a selector property nor multi-audio pads are present on the input
block today". Both rested on `docs/strom-block-config.md:50-59`, which lists only `srt_uri`,
`latency` and one `audio_out_0` pad. That reference is incomplete. @svensson00 corrected it on
#516 (2026-10-15), and the Strom source confirms the correction (Eyevinn/strom at `8fce2ee`):

- `builtin.mpegtssrt_input` already exposes `num_audio_tracks` (UInt, default 1, non-live,
  `backend/src/blocks/builtin/mpegtssrt_input.rs:682-693`). It creates the external pads
  `audio_out_0` … `audio_out_{N-1}` (`mpegtssrt_input.rs:77-85`), each backed by an
  `audio_output_<i>` identity. `builtin.efpsrt_input` has the same property and pads
  (`efpsrt_input.rs:103,127-133`).
- **What is missing is a stable mapping from stream to output.** In `link_to_output`
  (`mpegtssrt_input.rs:450`) a demuxer pad takes the **first output nothing feeds**, so the
  pad-added order decides which stream lands on `audio_out_k`. That order is not PID order. When
  every output is fed, the retire branch (`mpegtssrt_input.rs:498`, added in strom#877) takes over
  the output linked longest ago. That is the cause of #510 (a dual-audio feed plays stream 2) and
  is filed as strom#1077. Its agreed fix ("Option Park", `/agent-fix Park`) restores "first
  stream wins" for the takeover only. The Strom triage says plainly that mapping `audio_out_k` to
  PID order for `num_audio_tracks > 1` is a separate follow-up, and that follow-up is not yet
  filed.
- `builtin.efpsrt_input` never retires. It assigns audio outputs in arrival order behind a
  per-output `AtomicBool` (`efpsrt_input.rs:460`). EFP has no PIDs. Its only stream-pinning
  primitive, `data_stream_ids`, covers embedded-data tracks and not audio
  (`efpsrt_input.rs:40-70`).
- On the Open Live side the flow generator builds one input block per SRT/EFP source with only
  `srt_uri` + `latency` (`src/lib/flow-generator.ts:906-915`) and links a hard-coded
  `audio_out_0` into the per-source audio `time_offset` (`flow-generator.ts:928`).
  `SourceDoc.audioStreamIndex` is persisted (`src/db/types.ts:180-184`) but nothing reads it.
- An unconnected Strom output pad is not harmless. The flow generator already drains
  `group_out_N` because "Strom crashes at pipeline startup (502) if any group_out_N pad is left
  unconnected" (`flow-generator.ts:1237-1238`), and it drains loudness `audio_out` into a
  `fakesink` element (`flow-generator.ts:1217-1235`).
- @svensson00 settled ADR-006 Open Question 4 on #516: **stream-level selection for v1**. When
  a stored index is out of range, **clamp to the first stream**, and **show a warning on the
  input in Studio** so the operator knows the setting did not apply.
- The only operator-visible warning channel that exists today is `ActivationWarning`
  (`flow-generator.ts:82`, a single variant `recording-no-audio`). It is persisted as
  `ProductionDoc.activationWarnings` (`src/db/types.ts:837`, written at
  `src/routes/productions.ts:427`), replayed as WS `ERROR` frames on controller connect
  (`src/ws/controller.ts:4019-4022`), and listed per production in Studio. It is not scoped to an
  input.

## Decision

1. **Pipeline shape (replaces ADR-006 Decision 4).** No new selector property. For an `srt`
   source with an effective index `k > 0`, the flow generator sets
   `num_audio_tracks: k + 1` on `builtin.mpegtssrt_input` and links **`audio_out_<k>`** (in
   place of `audio_out_0`) into the per-source audio `time_offset`. Every other audio output
   `audio_out_<j>` (`j ≠ k`) is drained into its own `fakesink` element (`sync: false`), following
   the existing drain precedent, so that no output pad is left unconnected. When `k = 0`
   (absent or zero), the generated block and links are **byte-identical to today**: no
   `num_audio_tracks` property, and `audio_out_0` is linked. The default path therefore carries
   no new risk and relies on strom#1077's "first stream wins".

2. **Upstream gate (replaces ADR-006 Decision 5).** Wiring `audio_out_<k>` for `k > 0` is only
   correct once Strom maps `audio_out_k` to the k-th audio stream in ascending PID order. Today
   that mapping is arrival order, so `audio_out_1` may carry either stream. Open Live therefore
   ships the k>0 path **disabled behind a capability check** and treats every `k > 0` as
   "not applied" (Decision 4) until the capability is detected. The Strom follow-up issue must
   cover three things:
   (a) PID-order mapping when `num_audio_tracks > 1`;
   (b) a defined behaviour for an output whose stream does not exist, either an in-block fallback
       to the first stream or a reported "unfed" state;
   (c) a way for Open Live to detect the capability, preferably an exposed property or block
       definition change visible in `GET /api/blocks`, with a Strom version floor via
       `GET /api/version` as the fallback.
   Exact names are confirmed against live `GET /api/blocks` before wiring, as the standing rule
   in `docs/strom-block-config.md` requires.

3. **Scope: MPEG-TS/SRT only in v1.** `builtin.efpsrt_input` is out of scope. EFP has no PID
   order, the block assigns audio outputs in arrival order, and no upstream audio-pinning
   primitive exists or is tracked. For an `efp` source with `k > 0` the generator builds the
   unchanged `audio_out_0` shape and raises the Decision 4 warning
   (`reason: 'stream-type-unsupported'`). The API contract is unchanged: `audioStreamIndex`
   is still accepted on `efp` sources, as shipped in #518, so that a later EFP capability needs
   no API change.

4. **Clamp + input-scoped warning.** Whenever the effective index is not applied, the input
   is built with the first stream (`audio_out_0`, today's shape). The flow is **never** failed
   over the index. A new additive `ActivationWarning` variant carries the problem and is scoped
   to the input:
   `{ type: 'audio-stream-not-applied'; sourceId; mixerInput; requestedIndex; appliedIndex: 0; reason; message }`,
   where `reason ∈ { 'stream-type-unsupported', 'strom-capability-missing', 'stream-not-present' }`.
   It reaches Studio over the existing `activationWarnings` channels. Studio renders it **on
   the input** (keyed by `mixerInput`) as well as in the existing production-level list.
   Build-time reasons are known to Open Live. `stream-not-present` (the feed carries fewer than
   `k + 1` audio streams) is only knowable at runtime from Strom (Decision 2b). Open Live raises it
   from that signal once the follow-up exists, and the clamp itself is performed in-block by
   Strom (Decision 2b, preferred option) rather than by an Open Live flow rebuild.

## Consequences

**Positive**:
- No new Strom property is invented. The design uses `num_audio_tracks` and `audio_out_N`, both
  of which exist and are exposed. The upstream ask shrinks to a mapping rule and a capability
  signal.
- The default path (`k = 0`) is byte-identical to today, so for the overwhelming majority of
  sources the feature cannot regress the pipeline.
- The operator is never silently given a different stream than the one they chose. Every
  non-applied selection produces a warning on the affected input.
- The `ActivationWarning` union grows by one additive variant. The persisted field, REST
  surface and WS replay are reused, and no new endpoint is needed.

**Negative**:
- `k > 0` builds a block with `k + 1` audio outputs and decodes all of them in decode mode
  (`decodebin` exposes and decodes every stream), and `k` of them are thrown away into
  `fakesink`s. The CPU cost grows with the index. This is acceptable for the expected
  `k ≤ 3`.
- EFP sources cannot select a stream in v1. They get a warning and stay on the first stream.
- The feature stays "ready but inert" end to end until the Strom follow-up ships.

**Risks**:
- **Strom follow-up not filed / not accepted.** *Detection*: the capability check stays
  false, so every `k > 0` warns with `strom-capability-missing`. *Mitigation*: file the
  follow-up (owner: team-lead, outside this PR) and link it here before Accepted.
- **Wiring `audio_out_k` before the mapping lands** would play an arbitrary stream with no
  warning, which is the #510 failure mode again. *Mitigation*: the capability gate (Decision 2c).
  Implementation must not ship a "just link `audio_out_<k>`" path without it.
- **An unconnected `audio_out_j` crashing the flow** (the `group_out_N` precedent).
  *Mitigation*: drain every non-selected output (Decision 1). The flow-generator test asserts
  that every `audio_out_<0..k>` appears in exactly one link.
- **PID order is not what operators mean by "stream 2".** Most encoders allocate PIDs in
  PMT order, but some do not. *Detection*: once discovery lists streams with PIDs, the Studio
  picker shows them. *Mitigation*: spec Open Question 2.

## Alternatives Considered

- **Keep ADR-006 Decision 4: a new `audio_stream_index` selector property emitting on
  `audio_out_0`.** *Not chosen.* It asks Strom for a new primitive when the multi-output
  primitive already exists, and it still needs the same PID-ordering rule internally. Fewer pads
  and no drains would be its advantages. It stays acceptable if the Strom maintainers prefer it
  when the follow-up is filed, because Open Live's contract (`audioStreamIndex`, warning variant)
  does not change either way.
- **Wire `audio_out_<k>` now, without waiting for PID ordering.** *Rejected.* The mapping is
  arrival order (`mpegtssrt_input.rs:450`), so the operator's choice would be applied
  nondeterministically and silently. That is worse than not applying it and saying so.
- **Open Live performs the runtime clamp by rebuilding/restarting the flow with `k = 0`
  when the stream is missing.** *Rejected.* It restarts every input of the production on air
  in order to fix one input's audio. An in-block fallback in Strom is local to the affected
  input.
- **Insert a `builtin.liveaudiorouter` per input and switch crosspoints at runtime.**
  *Rejected for v1.* It adds a resample/deinterleave/mix chain per source and changes the
  per-source audio topology that `src/lib/audio-channels.ts` numbers. It is far more than
  stream-level selection needs.
- **Include EFP in v1 via arrival-order outputs.** *Rejected.* Same nondeterminism as above.
  A future `audio_stream_ids`-style pin, mirroring `data_stream_ids`, would be the natural
  upstream primitive and is out of scope here.
- **Fail activation (or reject the PATCH) on an out-of-range index.** *Rejected*, as in
  ADR-006. The stream count is unknown at write time, and losing a whole input over its audio
  choice is the worse failure. The PM decision is to clamp and warn.
