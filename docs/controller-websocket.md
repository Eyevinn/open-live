# Controller WebSocket Reference

The controller WebSocket carries the entire live production control surface for a
single production: mixer cuts and transitions, PiP, DSK, graphics, macros, audio
faders/routing, and the state broadcasts and meter data that keep every connected
client in sync.

```
WS /ws/productions/:id/controller
```

- `:id` is the production ID (the same ID used on the REST `/api/v1/productions/:id` routes).
- Route registration: `src/ws/controller.ts` (`controllerWs`, `fastify.get('/ws/productions/:id/controller', { websocket: true }, ...)`).
- Message framing: each frame is a single JSON object with a `type` discriminator.

## Status and stability

This endpoint is an **authenticated, externally reachable interface**, not a hidden
internal detail. The auth hook in `src/server.ts` explicitly guards the `/ws/`
prefix — its own comment notes that without that guard the endpoint "bypasses auth
entirely and accepts live production commands unauthenticated", and issue #101 was a
security fix for exactly that gap. Subscriber counts are also observable by operators
through `GET /api/v1/productions/{id}/controllers`. In short, the code already treats
this as a first-class surface that carries live production commands.

**Read-only observers are technically supported.** A client may connect, never send an
inbound message, and simply consume the outbound broadcasts (for example to observe
mixer cuts). Nothing in the handler requires a client to send anything; the connection
receives a state snapshot on connect and all subsequent broadcasts.

> **Stability note (TBD by maintainers).** What is documented below reflects the message
> contract as implemented in `src/ws/controller.ts` at the time of writing. Whether that
> contract is guaranteed to remain stable across releases — as opposed to evolving
> alongside the Studio frontend — has **not** been decided by the maintainers and is not
> asserted here. Treat the shapes below as accurate for the current version, but confirm
> the intended stability guarantee with the maintainers before building a long-lived
> integration on top of it.

## Authentication

Authentication applies **only when the `API_KEY` environment variable is set** on the
server. When it is unset, all routes (including this WebSocket) are unauthenticated.

When `API_KEY` is set, the upgrade request must carry the key one of two ways
(verified against the auth hook in `src/server.ts`):

- **`Authorization: Bearer <API_KEY>`** header, or
- **`?key=<API_KEY>`** query parameter on the upgrade URL.

The query-parameter form exists because the browser `WebSocket` API cannot set custom
request headers; non-browser clients that can set headers may use either form. The key
is compared with a constant-time comparison; a mismatch returns `401 Unauthorized` and
the upgrade is rejected.

```
wss://<host>/ws/productions/<id>/controller?key=<API_KEY>
```

## Inbound messages (client → server)

Inbound frames are validated against a discriminated union (`InboundMessageSchema` in
`src/ws/controller.ts`). Unknown or invalid frames receive an `ERROR` broadcast and are
otherwise ignored. The inbound type union (`src/ws/controller.ts`):

| `type` | Fields | Purpose |
|---|---|---|
| `CUT` | `mixerInput: string`, `afvRampUpMs?: number`, `afvRampDownMs?: number` | Hard cut the given input to PGM |
| `TRANSITION` | `mixerInput: string`, `transitionType: string`, `durationMs?: number`, `afvRampUpMs?: number`, `afvRampDownMs?: number` | Auto transition to the given input |
| `TAKE` | `pip?: number`, `transitionType?: string`, `durationMs?: number`, `afvRampUpMs?: number`, `afvRampDownMs?: number` | Swap PGM/PVW (take) |
| `SET_PVW` | `mixerInput: string` | Set the preview bus input |
| `FTB` | `active?: boolean`, `durationMs?: number` | Fade to black |
| `SET_OVL` | `alpha: number` | Set overlay alpha (0.0–1.0) |
| `GO_LIVE` | — | Mark the production on-air |
| `CUT_STREAM` | — | Take the production off-air |
| `GRAPHIC_ON` | `overlayId: string` | Show a graphics overlay |
| `GRAPHIC_OFF` | `overlayId: string` | Hide a graphics overlay |
| `DSK_TOGGLE` | `layer: number`, `visible?: boolean` | Toggle a downstream keyer layer |
| `MACRO_EXEC` | `macroId: string` | Execute a stored macro |
| `AUDIO_SET` | `elementId: string`, `property: 'volume' \| 'mute'`, `value: unknown`, `ramp_ms?: number` | Set a channel/main fader or mute |
| `AFV_SET` | `mixerInput: string`, `enabled: boolean` | Enable/disable audio-follows-video for an input |
| `AFV_RAMP_SET` | `rampUpMs: number`, `rampDownMs: number` | Set the AFV ramp times |
| `PFL_SET` | `elementId: string`, `enabled: boolean`, `volume?: number` | Pre-fade listen on a strip |
| `AFL_SET` | `elementId: string`, `enabled: boolean` | After-fade listen on a strip |
| `AUX_SEND_SET` | `elementId: string`, `auxBus: number`, `level: number`, `enabled: boolean`, `pre?: boolean` | Set a per-channel aux send |
| `AUX_MASTER_SET` | `auxBus: number`, `volume: number`, `muted: boolean` | Set an aux bus master fader |
| `GRP_SEND_SET` | `elementId: string`, `grpBus: number`, `level: number`, `enabled: boolean` | Set a per-channel group send |
| `GRP_MASTER_SET` | `grpBus: number`, `volume: number`, `muted: boolean` | Set a group bus master fader |
| `MONITOR_SET` | `volume: number`, `muted: boolean` | Set the operator monitor bus fader |
| `SOURCE_OFFSET_SET` | `mixerInput: string`, `offsetMs: number` | Set a per-source video time offset |
| `SOURCE_AUDIO_OFFSET_SET` | `mixerInput: string`, `offsetMs: number` | Set a per-source audio time offset |
| `LOUDNESS_RESET` | — | Reset the EBU R128 loudness integrator |
| `SELECT_PVW_PIP` | `pip: number` | Select a PiP slot into preview |
| `SET_PIP` | `pip: number`, `bg: number \| null`, `zones: PipZone[]`, `transforms?: PipTransforms` | Configure a PiP slot |
| `SET_EFFECT` | `target: EffectTarget`, `effect: VideoEffect` | Set a video effect on an input or master |

`VideoEffect` (the `effect` field of `SET_EFFECT`) is itself a discriminated union on
its own `type`: `none`, `chroma_key`, `pixelate`, `blur`, `duotone`, `vignette`, `vhs`,
`old_film`, `edge_glow`, `crt`, `halftone`, `thermal`, `night_vision`, `posterize`,
`underwater`, `color_correct`. See `SET_EFFECT` in `src/ws/controller.ts` for the
per-effect parameters.

## Outbound messages (server → client)

Outbound frames are JSON objects, each with a `type` discriminator. Most are sent via
`broadcast(productionId, ...)` to every client subscribed to the production; a few
(`ERROR`, `MACRO_ERROR`) are sent only to the originating socket. The following types
are emitted from `src/ws/controller.ts` and `src/services/meter-relay.ts`:

| `type` | Fields | Emitted when |
|---|---|---|
| `TALLY` | `pgm: string \| null`, `pvw: string \| null`, `pgmBg: string \| null`, `transitionType?: string`, `durationMs?: number` | Tally (PGM/PVW) changes; also sent on connect |
| `PIP_STATE` | `pgmPip: number \| null`, `pvwPip: number \| null`, `pips: PipConfig[]` | PiP program/preview/config changes; also sent on connect |
| `FTB_STATE` | `active: boolean` | Fade-to-black state changes |
| `ON_AIR` | `value: boolean` | Production goes on/off air (`GO_LIVE` / `CUT_STREAM`) |
| `OVL_STATE` | `alpha: number` | Overlay alpha changes; also sent on connect |
| `GRAPHIC` | `overlayId: string`, `active: boolean` | A graphics overlay is shown/hidden |
| `DSK_STATE` | `layer: number`, `visible: boolean` | A DSK layer toggles; also replayed on connect |
| `MACRO_EXECUTED` | `macroId: string` | A macro completed successfully |
| `MACRO_ERROR` | `macroId: string`, `failedActionIndex: number`, `error: string` | A macro action failed (sent to originating socket) |
| `AUDIO_STATE` | `elementId: string`, `property: 'volume' \| 'mute'`, `value: unknown` | A channel/main fader or mute changes; also replayed on connect |
| `AFV_STATE` | `mixerInput: string`, `enabled: boolean` | AFV toggled for an input; also replayed on connect |
| `AFV_RAMP_STATE` | `rampUpMs: number`, `rampDownMs: number` | AFV ramp times change; also sent on connect |
| `PFL_STATE` | `elementId: string`, `enabled: boolean` | PFL state changes; also replayed on connect |
| `AFL_STATE` | `elementId: string`, `enabled: boolean` | AFL state changes; also replayed on connect |
| `AUX_SEND_STATE` | `elementId: string`, `auxBus: number`, `level: number`, `enabled: boolean`, `pre?: boolean` | A per-channel aux send changes; also replayed on connect |
| `AUX_MASTER_STATE` | `auxBus: number`, `volume: number`, `muted: boolean` | An aux master changes; also replayed on connect |
| `GRP_SEND_STATE` | `elementId: string`, `grpBus: number`, `level: number`, `enabled: boolean` | A per-channel group send changes; also replayed on connect |
| `GRP_MASTER_STATE` | `grpBus: number`, `volume: number`, `muted: boolean` | A group master changes; also replayed on connect |
| `GRP_STATE_RESET` | — | Sent on connect when no group-send assignments exist, so clients clear stale state |
| `MONITOR_STATE` | `volume: number`, `muted: boolean` | Monitor bus changes; also replayed on connect |
| `SOURCE_OFFSET_STATE` | `mixerInput: string`, `offsetMs: number` | A per-source video offset changes; also replayed on connect |
| `SOURCE_AUDIO_OFFSET_STATE` | `mixerInput: string`, `offsetMs: number` | A per-source audio offset changes; also replayed on connect |
| `FX_STATE` | `fxAvailable: boolean`, `inputEffects: VideoEffect[]`, `masterEffect: VideoEffect` | Video-effect state changes; also sent on connect |
| `METER_DATA` | `elementId: string`, `peak`, `rms` | Audio meter tick (relayed from Strom); `elementId` is `main`, `monitor`, `ch{N}`, `aux{N}`, or `grp{N}` |
| `LOUDNESS_DATA` | `elementId: 'main'`, `momentary`, `shortterm`, `integrated`, `loudness_range`, `true_peak` | EBU R128 loudness tick (relayed from Strom) |
| `ERROR` | `error: string` | An inbound frame was invalid or an operation failed (sent to originating socket) |

`pgmBg` is the mixer input a PiP on program is composited over. It is `null` unless
`PIP_STATE.pgmPip` is set, so the two fields together distinguish an empty program
(`pgmPip` null) from a PiP over a known input (both set) from a PiP over nothing
(`pgmPip` set, `pgmBg` null). It is not tracked across the `MACRO_EXEC` cut,
transition, and take paths, which leave it holding the value from before the macro.

### Connect-time snapshot

On connect (and when a production is active), the server pushes a snapshot of current
state to the new socket before any further broadcasts: `TALLY`, `OVL_STATE` (if set),
`PIP_STATE`, any `DSK_STATE` layers, per-channel and master `AUDIO_STATE` /
`AUX_MASTER_STATE` / `GRP_MASTER_STATE` / `MONITOR_STATE`, `AUX_SEND_STATE`,
`GRP_SEND_STATE` (or `GRP_STATE_RESET`), `AFV_STATE`, `PFL_STATE` / `AFL_STATE`,
`SOURCE_OFFSET_STATE` / `SOURCE_AUDIO_OFFSET_STATE`, `AFV_RAMP_STATE`, and `FX_STATE`.
This lets a freshly-connected client rebuild the full control state without sending
any inbound messages. See the connect handler in `src/ws/controller.ts` for the exact
ordering.
