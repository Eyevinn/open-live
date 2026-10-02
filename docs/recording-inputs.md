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

Picture and sound go to separate recorders, and so to separate files, because
an input can carry only one of them: a guest who joins with audio only, or a
camera or encoder that sends no sound. A recorder with both tracks waits for
both before it writes anything, so such an input would not be recorded at all,
and in testing the stalled recorder also stopped another input's recorder. With
one recorder per track, the missing track's recorder stays idle and writes no
file.

The two files are separate timelines, so lining them up needs each file's
start time.

Each recording branch starts with a leaky queue, so a slow encoder or a
stalled recorder drops frames from the recording instead of holding up the
input's feed to the mixers.

If Strom lacks `builtin.audioenc` or `builtin.videoenc`, inputs are recorded
without that track. Without `builtin.recorder`, or without both encoders, they
are not recorded. Each case adds an `input-recording-incomplete` activation
warning, which the controller shows as an `ERROR` frame.

## Where the files go

```
recordings/<productionId>/<activation>/              program recording
recordings/<productionId>/<activation>/video_in_N/   <productionId>_video_in_N_{video,audio}_<timestamp>_<n>.mp4
```

`<activation>` is the activation's start time plus a uuid. On deactivate, with
object storage configured, every recorder is split and the files are uploaded
like the program's: object key `<RECORDING_KEY_PREFIX><productionId>/<file>`,
one `RecordingDoc` each, with `mixerInput` and `track` set for an input's file. Without
object storage the files stay on Strom.
