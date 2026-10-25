# ADR-011: Program and ISO input recording use Strom's Live Recorder, one A/V file per recorded input, with a `builtin.recorder` fallback that never drops program

**Date**: 2026-10-25
**Status**: Proposed

> Companion spec: [`docs/specs/iso-input-recording.md`](../specs/iso-input-recording.md).
> Issue: [Eyevinn/open-live#569](https://github.com/Eyevinn/open-live/issues/569) (OL-32), incl.
> @svensson00's scope note on open question 0. Studio: Eyevinn/open-live-studio#233.
> Supersedes the designs in draft PRs #411 and #489 (not ADRs; recorded here for traceability).

## Context

OL-32 records chosen inputs to their own files beside the program recording. Today program is
recorded by one `builtin.recorder` (`src/lib/flow-generator.ts:1124-1136` at `931715b`), which
writes through `splitmuxsink`. `splitmuxsink` releases a GOP only once every track has passed it,
so a track that stops freezes the whole recording and, through the tee in front of it, the
source's other branches (strom#1034 "Problem"; one stalled program video left a recording
audio-only for three hours). Arriving inputs — WHIP guests above all — stop and resume tracks
routinely, so the recorder choice is the first decision of the feature (#569 Q0).

Strom v0.7.0 (2026-10-08) ships `builtin.liverecorder` (strom#1034): same pads and properties as
the Recorder, a live muxer (`isofmp4mux` by default) where a quiet track holds nothing up and
resumes in the same file with a gap, late tracks released after 20 s, each split file starting at
t=0, the open file finalised inside the flow stop, and raw audio encoded to AAC in the block. It
emits the same `RecorderFileChanged` event. An exact per-file start time (strom#1057) is still
open.

Constraints:

- Strom refuses to start a flow that names a block it does not have, so naming
  `builtin.liverecorder` on an older Strom would take the whole production off air.
- The PM's scope note (#569): if Live Recorder is used for inputs, program moves to it in the same
  change (one block, one format, one event model); on a Strom without it, program **keeps**
  recording with `builtin.recorder` (unlike #489, which dropped it) and input recording may be
  refused with a warning.
- The live part upload (#566) and idempotent registration (#565) are the only upload/registration
  path; the new recorders must fit them.
- Alignment of input files with program within 1 s (AC 3) must hold without strom#1057.

## Decision

1. **Recorder block per activation, by capability.** open-live reads Strom's block list at
   activation. If it contains `builtin.liverecorder` (and `RECORDING_BLOCK` is not `recorder`),
   program **and** every recorded input use `builtin.liverecorder`. Otherwise — block missing,
   block list unreadable, or `RECORDING_BLOCK=recorder` — program uses `builtin.recorder` exactly
   as today, no input recorder is built, and an `input-recording-unavailable` activation warning
   is raised **only if** some input asked to be recorded. Detection is by block list, not by Strom
   version, and fails toward the block every Strom has.

2. **Taps before the lipsync offset, re-encoded.** Each recorded input (WHIP, SRT, EFP) is tapped
   at the pad that feeds its `time_offset` blocks, so the file holds the feed as it arrived. Video
   goes through a leaky queue and `builtin.videoenc` (H.264, 60-frame GOP,
   `RECORDING_INPUT_VIDEO_BITRATE_KBPS`); audio goes raw through a leaky queue into the recorder,
   which encodes AAC. Passthrough is out of v1 (`record: "passthrough"` is reserved and refused).

3. **One recorder and one file per recorded input, holding both tracks.** Not one recorder per
   track (#411/#489). Live Recorder does not stall on a quiet track and releases a track that never
   starts, which removes the reason tracks were split, and one A/V file per input is what an editor
   and the Studio player need.

4. **Same storage, layout and upload path as program.** Input files go to
   `recordings/<productionId>/<mixerInput>/`, keys `<productionId>/<mixerInput>/<file>`, to the
   activation's single `recording` output snapshot; one live-upload session per recorder on the
   shared recorder-event socket; registration by bucket+key. Recorder events are matched to a
   session by exact directory. On the Live Recorder path deactivate stops the flow first (the block
   finalises its files), then uploads input dirs and then the program dir; there is no split-now.

5. **Start times from the event stream.** A part's `startedAt` is, in order: Strom's
   `start_utc_us` (strom#1057, when present), the time open-live received `RecorderFileChanged`,
   the predecessor part's start + duration, the file-name stamp. `startedAtSource` on each
   `RecordingDoc` records which. Rule 2 meets AC 3 today (tens of ms); rule 1 makes it exact when
   strom#1057 ships, with no code change.

6. **Metadata on the `RecordingDoc`, not a sidecar.** `kind`, `mixerInput`, `sourceId`,
   `sourceName`, `streamType`, `guests`/`guestLabel`, `recorderType`, `startedAtSource` are stored
   per part and exposed (and filterable) through the existing recordings API. #411's
   `recordings.json` sidecar is not built.

## Consequences

**Positive**:

- A guest dropping video, or a camera losing audio, no longer stalls a recording or the feeds
  behind it; program gets the same robustness.
- One block, one container (fragmented MP4), one event model for program and inputs; each split
  file plays on its own from t=0.
- Existing productions keep recording on any Strom: the worst case is today's behaviour.
- AC 3 is met without waiting on Strom, and becomes exact when strom#1057 lands.
- No new upload or registration mechanism; #565/#566 semantics extend per directory.
- `RECORDING_BLOCK=recorder` is a no-rebuild escape hatch if Live Recorder misbehaves.

**Negative**:

- fMP4 from `isofmp4mux` carries no header duration, so open-live must sum fragment durations to
  list `durationMs` (own code in `Mp4DurationScanner`).
- Each recorded input costs an H.264 encode on the shared GPU (plus disk on the Strom host until
  upload); a cap (`RECORDING_MAX_INPUTS`, default 4) and a load measurement are needed.
- Two code paths (Live Recorder and Recorder) for program until older Strom builds are gone.
- Live-upload sessions become per recorder; the event-matching rule must change from prefix to
  exact directory, or nested input dirs corrupt program part detection.
- Input recording requires a program recording output (one storage choice per production); ISO
  without program is not offered.

**Risks**:

- Live Recorder is a new Strom block. Detection: part gaps or missing parts in ticket 1's ≥35-min
  dev recording (AC 9); production logs of `RecorderFileChanged` cadence. Response:
  `RECORDING_BLOCK=recorder`.
- GPU encoder sessions exhausted (consumer NVENC limits) with many recorded inputs. Detection:
  load-measurement ticket; encoder fallback/failure in Strom logs. Response: lower the cap.
- A WHIP guest whose video arrives >20 s after audio records audio-only until the next part
  (Live Recorder's late-track release). Detection: ticket 2's WHIP verification; Response: Strom
  issue, not an open-live workaround.
- Editors that import fragmented MP4 poorly. Detection: AC 7 check. Response: remux-on-upload
  follow-up.

## Alternatives Considered

- **Keep `builtin.recorder` for program and inputs.** Rejected: a guest that stops a track freezes
  that input's recording and back-pressures its tee (the strom#1034 failure), and two-track
  recorders record nothing for audio-only guests, which forced #411 into per-track files.
- **Live Recorder for inputs only, program stays on `builtin.recorder`.** Rejected by the PM's
  scope note: program and inputs would differ in container, timing and stall behaviour, and
  aligning them would need two timing models.
- **#489's fallback: drop program recording on a Strom without Live Recorder.** Rejected: a
  production that records today would stop recording after an open-live upgrade (scope note).
- **Gate on Strom version (≥ v0.7.0) instead of the block list.** Rejected: a version check
  would have to track pre-releases, dev builds and backports, while the block list is exactly
  what Strom checks when it refuses a flow. Same pattern as `stromHasAudioEncoder`.
- **One recorder per track (#411/#489).** Rejected (Decision 3): two files to re-sync per input,
  and the Strom maintainers rejected per-track recorders in strom#1034 for the same reason.
- **Per-activation `recordings.json` sidecar (#411).** Rejected for v1: a second source of truth
  beside the `RecordingDoc`s that must be kept consistent through retries, restarts and deletes.
  The API carries the same facts; a TAMS writer can be specified against it later.
- **Wait for strom#1057 before shipping.** Rejected: event receipt time already meets the 1 s
  criterion, and the exact field is parsed the moment Strom sends it.
