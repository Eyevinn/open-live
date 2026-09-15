# Strom Block Configuration Reference

> **Agent rule**: Always use the generated Strom OpenAPI client to read and update flows/blocks/properties.  
> Do NOT hand-edit flow JSON, do NOT call REST endpoints with raw fetch, and do NOT invent endpoint paths.  
> Prefer values fetched live from `GET /api/blocks` (`BlockDefinition[].exposed_properties`) over the values here — the OpenAPI schema is authoritative at runtime.

---

## `builtin.vision_mixer`

Video vision mixer with DSK overlay support.

| Property | Type | Notes |
|---|---|---|
| `num_inputs` | string (enum) | `"2"`, `"4"`, `"6"`, `"8"`, `"10"` — **non-live**, set at creation |
| `num_dsk_inputs` | string (enum) | `"0"`, `"1"`, `"2"` — number of downstream keyer inputs, **non-live** |
| `dsk_N_alpha_mode` | string (enum) | `"straight"` (default), `"premultiplied"` — alpha of the source on `dsk_in_N`, **non-live**. Open Live sets `"premultiplied"` for every DSK input fed by `cefsrc`. Requires Eyevinn/strom#809; older Strom ignores it |
| `pgm_resolution` | string (enum) | `"3840x2160"`, `"1920x1080"`, `"1280x720"`, `"720x576"`, `"720x480"` |
| `multiview_resolution` | string (enum) | same values as `pgm_resolution` |
| `pgm_framerate` | string (enum) | `"24000/1001"`, `"24/1"`, `"25/1"`, `"30000/1001"`, `"30/1"`, `"50/1"`, `"60000/1001"`, `"60/1"` |
| `input_N_alpha` | number | Alpha for video input N (0.0–1.0), live |

**Pads** (depend on `num_inputs` and `num_dsk_inputs`):
- Video inputs: `video_in_0` … `video_in_{num_inputs-1}`
- DSK inputs: `dsk_in_0` … `dsk_in_{num_dsk_inputs-1}`
- Audio inputs: `audio_in_0` … `audio_in_{num_inputs-1}`, `pgm_audio_in`
- Outputs: `pgm_out`, `multiview_out`

---

## `builtin.mixer`

Audio mixer with channel strips, aux buses, and groups.

| Property | Type | Notes |
|---|---|---|
| `num_channels` | integer | Number of input channels (1-indexed pads `input_1` … `input_N`), **non-live** |
| `num_aux_buses` | integer | Number of aux buses, **non-live** |
| `num_groups` | integer | Number of group buses, **non-live** |

**Pads** (verified from live `GET /api/blocks` — authoritative):
- Inputs: `input_1` … `input_{num_channels}` (1-indexed)
- Outputs: `main_out` (programme mix), `monitor_out` (headphone/PFL bus)

**Note**: AUX and GRP buses are internal to the block; they have no external output pads and cannot be wired to downstream blocks. Only `main_out` and `monitor_out` are externally connectable. The previously documented `pfl_out` pad does not exist — the correct name is `monitor_out`.

**Wiring note**: Set `num_channels` = number of SRT/EFP sources at activation. Wire each SRT source `audio_out_0` → `input_{N}` (1-indexed).

---

## `builtin.mpegtssrt_input`

Receives an MPEG-TS stream over SRT.

| Property | Type | Notes |
|---|---|---|
| `srt_uri` | string | Full SRT URI, e.g. `srt://192.168.1.10:9000?mode=caller` |
| `latency` | integer (ms) | 20–8000, default 125 |

**Pads**: outputs `video_out`, `audio_out_0`

---

## `builtin.mpegtssrt_output`

Sends MPEG-TS program output over SRT. Supports multiple audio tracks as separate PIDs in the transport stream. Auto-encodes raw audio to AAC.

| Property | Type | Notes |
|---|---|---|
| `srt_uri` | string | Full SRT URI, e.g. `srt://:6000?mode=listener` |
| `num_audio_tracks` | uint | Number of audio input tracks. Default 1 |
| `num_video_tracks` | uint | Number of video input tracks. Default 1 |
| `latency` | int (ms) | SRT latency. Default 125 |

**Pads** (verified from live `GET /api/blocks`):
- Video input: `video_in` (V0)
- Audio inputs: `audio_in_0` (A0), `audio_in_1` (A1) … one per track

---

## `builtin.efpsrt_output`

Sends EFP-muxed audio/video over SRT. Supports multiple audio tracks.

| Property | Type | Notes |
|---|---|---|
| `srt_uri` | string | Full SRT URI |
| `num_audio_tracks` | uint | Number of audio input tracks. Default 1 |
| `num_video_tracks` | uint | Number of video input tracks. Default 1 |
| `latency` | int (ms) | SRT latency. Default 125 |

**Pads** (verified from live `GET /api/blocks`):
- Video input: `video_in` (V0)
- Audio inputs: `audio_in_0` (A0), `audio_in_1` (A1) … one per track

---

## `builtin.whep_output`

WebRTC WHEP output endpoint for browser playback. Supports multiple audio tracks — each track is a separate WebRTC audio track in the stream.

| Property | Type | Notes |
|---|---|---|
| `endpoint_id` | string | Unique endpoint name; flow-generator appends a per-production suffix |
| `num_video_tracks` | uint | Number of video input tracks; 0 disables video. Default 1 |
| `num_audio_tracks` | uint | Number of audio input tracks; 0 disables audio. Default 1 |
| `ts_offset_ms` | int | Timestamp offset for playout timing (negative = earlier release) |

**Pads** (verified from live `GET /api/blocks`):
- Video inputs: `video_in` (V0), `video_in_1` (V1) … for each video track
- Audio inputs: `audio_in` (A0), `audio_in_1` (A1) … for each audio track
- No outputs

**Multi-track audio**: set `num_audio_tracks: 2` to carry programme + monitor bus on the same WHEP endpoint. Connect `main_out` (via loudness) → `audio_in`, `monitor_out` → `audio_in_1`.

---

## `builtin.videoenc`

Encodes raw video to H.264/H.265 for downstream consumers.

| Property | Type | Notes |
|---|---|---|
| `bitrate` | integer (kbps) | 100–100000 |

**Pads**: input `video_in`, output `encoded_out`

---

## `builtin.videoformat`

Converts/scales video to a target resolution.

| Property | Type | Notes |
|---|---|---|
| `resolution` | string | e.g. `"1920x1080"`, `"1280x720"` |

**Pads**: input `video_in`, output `video_out`

---

## `builtin.whip_input`

Receives a WebRTC stream via WHIP protocol.

| Property | Type | Notes |
|---|---|---|
| `endpoint_id` | string | Unique WHIP endpoint name |

**Pads**: output `video_out`

---

## `builtin.loudness`

EBU R128 loudness meter. Audio passes through unchanged — use as an in-line measurement tap.

| Property | Type | Notes |
|---|---|---|
| `interval` | string (enum) | `"100"`, `"200"`, `"500"`, `"1000"` (ms) — **must be a string**, not a number |

**Pads** (verified from live `GET /api/blocks`):
- Input: `audio_in`
- Output: `audio_out`

---

## Agent Rules

1. Always match blocks by `block_definition_id`, never by `id` or `name`.
2. Use the OpenAPI client exclusively — never raw `fetch`/`curl`.
3. `num_inputs`, `num_dsk_inputs`, `num_channels`, `num_aux_buses`, `num_groups` are **non-live** — must be set at flow creation, cannot be changed on a running flow.
4. `srt_uri` values must be valid SRT URIs (`srt://…`), not plain host:port strings.
5. `latency` must be an integer (not a float).
6. `bitrate` must be an integer in kbps.
7. All resolution strings use `WxH` format (e.g. `"1920x1080"`).
8. Audio mixer inputs are 1-indexed (`input_1`, `input_2`, …). Vision mixer audio inputs are 0-indexed (`audio_in_0`, `audio_in_1`, …).
9. Prefer live `GET /api/blocks` schema over this file for valid enum values — this file may lag runtime.
10. Always flag drift between this file and the live OpenAPI schema.
