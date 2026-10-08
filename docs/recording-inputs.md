# Recording inputs

Each source assignment chooses whether its input is recorded on its own,
beside the program recording:

```
POST /api/v1/productions/:id/sources   { "sourceId": "Whip", "mixerInput": "video_in_1", "record": "transcode" }
```

| `record` | |
| --- | --- |
| `off` (default) | Not recorded. |
| `transcode` | Decoded and re-encoded into the recorder. |
| `passthrough` | Encoded streams straight into the recorder. Not built yet: the route answers 400. |

Recording is off unless the assignment opts in: the feed may already be
recorded upstream (it came through a recording pre-router, say), and in a
delayed production the mixer inputs are bridged out of the store, where
recording them again would duplicate them. Like every other flow setting it
is read at activation, so a change takes effect on the next activation.
Assigning a source again replaces the whole assignment, so a request without
`record` turns recording off.

Only arriving feeds (WHIP, SRT, EFP) can be recorded this way. An assignment
of a test pattern, HTML source or clip that asks for it, or one that carries
`passthrough` from before the route refused it, is skipped with an
`input-recording-incomplete` activation warning. The program recording is
still set up by assigning a `recording` output, independently of this
setting.

## What is recorded

Each recorder taps its input before the `time_offset` blocks, so it holds the
feed as it arrived, with no lipsync trim applied. The trims are pad offsets on
running time, so a trim changed mid-show would make the recording's timestamps
jump.

`transcode` takes the decoded picture and sound through `builtin.videoenc`
(H.264, a keyframe every 60 frames, which is 2 s at the 30 fps browsers send)
and `builtin.audioenc` (AAC). It is the mode for WHIP feeds, because browser
H.264 has irregular keyframes and a keyframe request cannot reach the browser
through Strom's WHIP session bridge. It works for SRT/EFP too, at the cost of a
software encode per input on the Strom host. `passthrough`, for SRT/EFP
encoders with a fixed GOP, will record their encoded streams without decoding.

Picture and sound go to separate recorders (`builtin.liverecorder`), and so to
separate files, because an input can carry only one of them: a guest who joins
with audio only, or a camera or encoder that sends no sound. The missing
track's recorder stays idle and writes no file. A track that stops and comes
back continues in the same file, with a gap where it was missing.

The two files line up by their start times in `recordings.json` (below).

Each recording branch starts with a leaky queue, so a slow encoder or a
stalled recorder drops frames from the recording instead of holding up the
input's feed to the mixers.

If Strom lacks `builtin.audioenc` or `builtin.videoenc`, inputs are recorded
without that track. Without `builtin.liverecorder`, or without both encoders, they
are not recorded. Each case adds an `input-recording-incomplete` activation
warning, which the controller shows as an `ERROR` frame.

## Where the files go

```
recordings/<productionId>/<activation>/              program recording, recordings.json
recordings/<productionId>/<activation>/video_in_N/   <productionId>_video_in_N_{video,audio}_<timestamp>_<n>.mp4
```

`<activation>` is the activation's start time plus a uuid. On deactivate, with
object storage configured, every recorder is split, the flow is stopped once
each split has opened its next file, and the files are uploaded like the
program's: object key `<RECORDING_KEY_PREFIX><productionId>/<file>`,
one `RecordingDoc` each, with `mixerInput` and `track` set for an input's file. Without
object storage the files stay on Strom.

## `recordings.json`

Open Live writes a sidecar into each activation's directory, rewrites it after
each recorder event, and writes it a last time on deactivate. With object
storage it is copied to `<RECORDING_KEY_PREFIX><productionId>/<activation>/recordings.json`
and is not listed as a recording.

```jsonc
{
  "version": 1,
  "productionId": "prod-…",
  "productionName": "…",
  "flowId": "…",
  "dir": "recordings/prod-…/20261001T100000Z-…",
  "activatedAtMs": 1790848800000,      // when Open Live started the flow
  "updatedAtMs": 1790852400000,
  "program": {                          // null without a recording output
    "recorderBlockId": "…",
    "outputDir": "…",
    "startedAtMs": 1790848800312.5,    // first file's startMs (else openedAtMs), null until one opens
    "files": [{ "path": "recordings/…/prod-…_20261001_100000_00000.mp4", "openedAtMs": 1790848800400, "startMs": 1790848800312.5 }]
  },
  "inputs": {
    "video_in_1": {
      "sourceId": "Whip",
      "sourceName": "WHIP Input",
      "streamType": "whip",
      "recordMode": "transcode",
      "outputDir": "recordings/…/video_in_1",
      "tracks": {                       // a track is absent when Strom cannot record it
        "video": { "recorderBlockId": "…", "outputDir": "…", "startedAtMs": 1790848891874.1, "files": [{ "path": "…_video_…", "openedAtMs": 1790848892000, "startMs": 1790848891874.1 }] },
        "audio": { "recorderBlockId": "…", "outputDir": "…", "startedAtMs": 1790848889951.6, "files": [{ "path": "…_audio_…", "openedAtMs": 1790848890000, "startMs": 1790848889951.6 }] }
      },
      "guests": [{ "inviteId": "…", "label": "Anna", "joinedAt": "2026-10-01T10:01:00.000Z", "leftAt": "2026-10-01T10:20:00.000Z" }]
    }
  }
}
```

A recorder opens its file on its first buffer, so for a WHIP input its first
file starts when the guest's media first arrived, not when the flow started.

`startMs` is the file's t=0 on Strom's pipeline clock, mapped to UTC
milliseconds (fractional), as Strom reports it in `RecorderFileChanged`. A
moment at wall-clock time `T` is at `T - startMs` into the file, and the same
moment has the same `startMs + t` in every file of the activation, so an
input's video and audio files line up exactly. It is absent when Strom does
not report it (Strom before Eyevinn/strom#944).

`openedAtMs` is when Open Live received the event. Without `startMs` it is the
only start time, and it is late by the event's delivery and the encoder's
start-up delay. These differ between an input's video and audio files: in a
200 s test with a file split every 20 s, files lined up this way were 50 ms
early to 15 ms late (WHIP) and 50 to 80 ms late (SRT) against one two-track
file of the same input.

`guests` lists the guest sessions on that input during the activation, from
their session documents: `joinedAt` is the session's creation and `leftAt` its
last update once it has left.

Not listed: a file opened while Open Live was not connected to Strom's event
stream.

The final split at deactivate leaves each recorder a last file of a few
milliseconds, listed like any other. Strom's stop does not finalise it, so it
may hold one frame or no media at all; skip a file you cannot read.

## For tools that read these recordings

A separate writer (a TAMS store, for one) can pick the recordings up from the
layout above without asking Open Live:

- Every activation that records anything has its own directory, and its
  `recordings.json` sits at the top of it. Input files are only ever in that
  directory's `video_in_N/` subdirectories, one per recorded input.
- Each file holds one track; `track` in its `RecordingDoc`, and the
  `{video,audio}` part of its name, say which.
- `inputs` in `recordings.json` is keyed by `mixerInput` and gives the source
  (`sourceId`, `sourceName`, `streamType`), the guests on it, and
  `recordMode`.
- Each file's `startMs` is the UTC time its timeline starts at, exact across
  files of the same activation; `openedAtMs` stands in, less exactly, when
  `startMs` is absent.
- `version` changes if a field is renamed or removed; new fields may be added
  without a change.
