# Spec: RTMP multi-destination output with platform presets (OL-11)

**Status: Proposed** (2026-09-18) — Phase 1 spec-only deliverable for the epic-workflow team-lead gate.
Implementation may not begin until this spec + ADR-004 are reviewed and the Open Questions below are
resolved, and until the load-bearing upstream Strom dependencies (strom#783, strom#840) close.
**Author:** architect agent
**Related issues:** Eyevinn/open-live#319 (OL-11 epic — backend), Eyevinn/open-live-studio#143
(Studio companion — destination-management UI). Upstream dependencies (both OPEN, not duplicated
here): strom#783 (`rtmp_output` default video profile not constrained to what RTMP receivers accept),
strom#840 (refused input leaves the identity src pad unlinked → `Internal data stream error` instead
of a clean per-destination rejection).

## Problem Statement

Open Live has no way to publish a production to YouTube Live, Twitch, or Facebook. Today the
`OutputType` union is closed to exactly `'mpegtssrt' | 'efpsrt' | 'whep' | 'recording'`
(`src/db/types.ts:187`, confirmed live 2026-09-18) — there is no RTMP member, no destination model
that supports multiple simultaneous social destinations per production, and no per-platform preset.

An operator who wants to restream to a social platform today has no path at all: the outputs surface
(`src/routes/outputs.ts`) only accepts the four types above, and the flow generator only emits
`builtin.mpegtssrt_output`, `builtin.whep_output`, and `builtin.recorder` blocks
(`src/lib/flow-generator.ts:860-935`). There is no RTMP block wired, and no place to store a
platform stream key as a credential.

**Target outcome (v1):** an operator adds one or more RTMP destinations to a production —
picks a platform (YouTube / Twitch / Facebook preset), pastes a stream key, done — and Open Live
streams the program feed to all of them simultaneously, with encoder defaults the platforms accept
without operator tuning.

### Grounding (what exists today)

- **Output model.** `OutputDoc` (`src/db/types.ts:200-218`) carries `outputType: OutputType`, an
  optional `url` (SRT URI for `mpegtssrt`/`efpsrt`, absent for `whep`/`recording`), and a derived,
  never-persisted `status?: OutputStatus` (`'healthy' | 'degraded' | 'down' | 'unknown'`, computed on
  read — `src/lib/production-health.ts`, issue #255). Outputs are attached to a production via
  `ProductionDoc.outputAssignments?: ProductionOutputAssignment[]` (`src/db/types.ts:220-222, 389`),
  where `ProductionOutputAssignment` is just `{ outputId: string }`.
- **Outputs REST surface.** `src/routes/outputs.ts` — `GET/POST /api/v1/outputs`,
  `GET/PATCH/DELETE /api/v1/outputs/:id`. Create uses the `OutputInput` zod schema
  (`outputs.ts:57-69`, `outputType: z.enum([...])`); patch uses `OutputPatch` (`outputs.ts:71-74`).
  Validation failures return `400`, unknown id `404`, in-use-by-active-production delete `409`
  (`outputs.ts:242-244`), DB-unavailable `503`.
- **Secret masking on read.** SRT passphrases are masked on API responses via `maskSrtPassphrase()`
  (`outputs.ts:76-79`) inside `toApi()` (`outputs.ts:81-106`) — the credential is never returned to
  the client in plaintext. This is the house pattern the stream key reuses.
- **Secret-at-rest precedent — reuse this, do not reinvent.** SRT passphrases are already encrypted
  at rest with AES-256-GCM under the `SRT_PASSPHRASE_KEY` env var, with a self-describing `encv1:`
  wire prefix, "fail closed in production, loud no-op in dev", and a hard "never log the plaintext or
  the key" rule (`src/lib/srt-passphrase-crypto.ts:1-33, 117-157`). The outputs route already calls
  `encryptAddressPassphrase()` on write and `decryptAddressPassphrase()` before masking
  (`outputs.ts:9, 88, 157, 213-215`). This is the house pattern for a stored output secret; this spec
  builds on it (see ADR-004 and Open Question 2 on the key choice).
- **Flow wiring.** Outputs become Strom blocks in `src/lib/flow-generator.ts:853-937`. Each output
  becomes one block (`builtin.recorder` / `builtin.whep_output` / `builtin.mpegtssrt_output`) linked
  from the program feed pad (`pgmFeedPad → :video_in`) and the main audio bus
  (`mainAudioSource → :audio_in_0`). An SRT output with no `url` is skipped
  (`flow-generator.ts:918-919`) because an empty URI fails at GStreamer READY. Encoder bitrate is set
  on `builtin.videoenc` blocks named `Enc PGM` / `Enc MV` (`flow-generator.ts:212-222`).
- **Strom capability.** Strom already ships `builtin.rtmp_output`, merged in strom PR#827, released in
  v0.6.9 (2026-09-16). Strom docs PR#776 states `rtmp2sink` accepts YouTube's and Twitch's RTMP(S)
  URL shapes unmodified — but nothing has been streamed end-to-end to a real platform yet (Tier 1
  until run live, per the epic).

## Scope

**In scope for v1** (faithful to epic#319 "In scope for v1"):
1. A new `OutputType` member for RTMP/RTMPS.
2. A per-production **multi-destination model**: multiple simultaneous RTMP destinations per
   production, each with its own platform preset + stream key, fanned out from the same program feed.
3. **Platform presets** (YouTube, Twitch, Facebook) where the operator supplies only a stream key and
   the preset supplies the RTMP(S) ingest URL template — no manual URL construction for the preset
   case. (Which presets ship in v1 is Open Question 1.)
4. **Encoder defaults** RTMP receivers accept out of the box, so the operator does not tune the
   encoder (ties to strom#783).
5. **Stream key as a credential**: encrypted at rest (reusing `srt-passphrase-crypto`), never logged
   in plaintext, never shipped to the browser unmasked.

**Explicitly OUT of v1 scope** (per epic#319):
- OAuth "sign in with YouTube / Twitch" account integration — possible follow-up only. v1 is
  paste-a-stream-key only.
- A generic user-supplied arbitrary-RTMP-URL destination is **not** the headline v1 flow (the preset
  path is); whether a "custom / other" preset ships alongside the three named presets is Open
  Question 1.
- Active per-destination liveness probing beyond what Strom exposes — see Open Question 3 and the
  existing flow-level `OutputStatus` derivation (issue #255).

## Data Model

### New `OutputType` member

```ts
// src/db/types.ts:187 — add the RTMP member (additive; existing members unchanged)
export type OutputType = 'mpegtssrt' | 'efpsrt' | 'whep' | 'recording' | 'rtmp';
```

A single `'rtmp'` member covers both RTMP and RTMPS — the scheme is carried in the resolved ingest
URL (the presets use `rtmps://` where the platform requires it), mirroring how `'mpegtssrt'`/`'efpsrt'`
both funnel through the one `builtin.mpegtssrt_output` block (`flow-generator.ts:916-917`). This keeps
the union minimal and avoids a second near-duplicate member.

### Per-production multi-destination model

The existing `OutputDoc` is a first-class, production-attachable output, and `outputAssignments` is
already a **list** (`ProductionDoc.outputAssignments?: ProductionOutputAssignment[]`,
`src/db/types.ts:389`). The multi-destination requirement is therefore satisfied by modelling **each
RTMP destination as its own `OutputDoc` with `outputType: 'rtmp'`**, all attached to the same
production via multiple `outputAssignments` entries — no new collection, no schema restructuring, and
the flow generator's per-output loop (`flow-generator.ts:854`) already fans out one block per assigned
output. This reuses delete-guard (`409` in active production), health derivation, and masking that the
outputs surface already provides.

`OutputDoc` gains RTMP-only fields (all optional; absent for the four existing types):

```ts
// src/db/types.ts — OutputDoc addition. Present only when outputType === 'rtmp'.
export interface RtmpDestination {
  /** Which platform preset supplied the ingest URL template. 'custom' pending OQ1. */
  platform: 'youtube' | 'twitch' | 'facebook';   // v1 set — see Open Question 1
  /**
   * The resolved RTMP(S) ingest URL for the preset, WITHOUT the stream key,
   * e.g. "rtmps://a.rtmp.youtube.com/live2". Derived from the preset at write
   * time; stored so a preset-table change does not silently repoint a live
   * destination. Never carries the key.
   */
  ingestUrl: string;
  /**
   * The platform stream key. WRITE-ONLY over the API: accepted on write, never
   * returned; encrypted at rest with the `encv1:` bundle (srt-passphrase-crypto),
   * exactly like an SRT passphrase. Stored on the doc, never in `ingestUrl`.
   */
  streamKeyEnc?: string;   // encv1:<...>  — never the plaintext, never returned
}
```

`OutputDoc` gains `rtmp?: RtmpDestination`. The existing `url?` field stays **unused** for RTMP
outputs — the ingest URL + key live in the structured `rtmp` object so the key is never smeared into a
free-text URL that could leak via logs or the derived `connect` address (`outputs.ts:95-101`). A
read-only `streamKeySet: boolean` echo is surfaced on the API (analogous to ADR-003's `valueSet`),
never the key itself.

### Encryption at rest (non-negotiable)

`rtmp.streamKeyEnc` is encrypted **before** the output doc is persisted and decrypted only just before
the resolved URL is handed to Strom's `builtin.rtmp_output` at flow-generation time — reusing
`src/lib/srt-passphrase-crypto.ts` (AES-256-GCM, `encv1:` prefix, fail-closed in production). The
plaintext stream key is **never** stored, **never** logged (mirroring open-live PR#316's
address-redaction discipline), and **never** returned by the API. `toApi()` (`outputs.ts:81-106`) is
extended to emit `rtmp: { platform, ingestUrl, streamKeySet: <bool> }` and to strip `streamKeyEnc`
entirely — the key is neither masked-in-URL nor echoed. Whether it stays under `SRT_PASSPHRASE_KEY`
or a dedicated key is **Open Question 2** (see ADR-004).

### Migration

**Purely additive, no CouchDB migration.** `'rtmp'` is a new union member; `rtmp?` is optional and
absent on all existing docs. Existing outputs and productions are unchanged. The new REST fields are
additive to `OutputInput`/`OutputPatch`; Studio clients that ignore them keep working. No RTMP
destination is created implicitly — only by an explicit create with `outputType: 'rtmp'`.

## API Design

Additive to the existing outputs surface (`src/routes/outputs.ts`) — same CRUD, same error
conventions. Attaching a destination to a production reuses the **existing** output-assignment
mechanism (`ProductionDoc.outputAssignments`), so there is no new "add destination to production"
endpoint; a destination is an output, and outputs are assigned to productions as they are today.

### Create an RTMP destination

`POST /api/v1/outputs`

```jsonc
// request — preset case: operator supplies platform + stream key only
{
  "name": "YouTube — main channel",
  "outputType": "rtmp",
  "rtmp": {
    "platform": "youtube",
    "streamKey": "xxxx-xxxx-xxxx-xxxx"   // write-only: accepted here, never returned
  }
}
```

The server resolves `ingestUrl` from the platform preset table (see Configuration), encrypts
`streamKey` into `rtmp.streamKeyEnc` via `encryptPassphrase()`, and persists. No SRT listener port is
leased for RTMP (RTMP is an outbound connect to the platform, unlike the SRT-listener path at
`outputs.ts:135-171`), so the port-lease branch is skipped for `outputType: 'rtmp'`.

```jsonc
// 201 response — key never echoed; streamKeySet reflects storage
{
  "id": "output-...",
  "name": "YouTube — main channel",
  "outputType": "rtmp",
  "rtmp": { "platform": "youtube", "ingestUrl": "rtmps://a.rtmp.youtube.com/live2", "streamKeySet": true },
  "status": "unknown",
  "createdAt": "2026-09-18T...", "updatedAt": "2026-09-18T..."
}
```

### Patch an RTMP destination

`PATCH /api/v1/outputs/:id` — extends `OutputPatch` (`outputs.ts:71-74`) with an optional
`rtmp: { platform?, streamKey? }`. A new `streamKey` re-encrypts and replaces the stored key; a new
`platform` re-resolves `ingestUrl`. Omitting `streamKey` leaves the stored key untouched (same
"leave the URL as-is when the patch does not carry it" behaviour as `outputs.ts:213-215`). To
**clear** a key, an explicit `streamKey: ""` or a `rotate` action is used (mirrors ADR-001's rotate
posture — see Open Question 3 on whether a dedicated rotate endpoint is warranted).

### List / get / delete — unchanged surface

`GET /api/v1/outputs`, `GET /api/v1/outputs/:id`, `DELETE /api/v1/outputs/:id` behave exactly as today;
RTMP outputs simply carry the `rtmp` object (key stripped) in responses. Delete is blocked with `409`
while the destination is assigned to an active/activating production (`outputs.ts:237-244`) — this now
covers RTMP destinations too.

### Error codes

Reuse the existing zod-`400` / `404` / `409` / `503` conventions in `src/routes/outputs.ts`:

| Code | Case |
|---|---|
| `400` | `rtmp` present on a non-`rtmp` output, or absent on an `rtmp` output; unknown `platform` (not in the v1 preset set); `streamKey` fails validation (empty on create, over length); an SRT-only field (`url`) supplied on an `rtmp` output. Same `superRefine` path as `srtUrl()` validation (`outputs.ts:61-68`). |
| `404` | Unknown `:id`. |
| `409` | Delete or key-mutation on a destination assigned to an **active/activating** production (`outputs.ts:237-244`), extended to cover `rtmp` key rotation, not just delete. |
| `503` | Outputs DB unreachable (`outputs.ts:115-117`). |

**No stream key is ever returned** by any endpoint — write-only, exactly like the SRT passphrase and
the ADR-001 gateway token.

## Service Interactions

```mermaid
sequenceDiagram
    participant Op as Operator (Studio UI)
    participant OL as open-live (outputs API + flow-generator)
    participant DB as CouchDB
    participant Strom
    participant Plat as Platform RTMP ingest (YouTube/Twitch/Facebook)

    Note over Op,OL: Configure a destination (preset + stream key)
    Op->>OL: POST /api/v1/outputs { outputType:'rtmp', rtmp:{ platform:'youtube', streamKey } }
    OL->>OL: validate (platform in preset set; key present); resolve ingestUrl from preset table
    OL->>OL: encrypt streamKey (srt-passphrase-crypto, encv1:) → rtmp.streamKeyEnc
    OL->>DB: persist OutputDoc (ciphertext only; ingestUrl carries NO key)
    OL-->>Op: 201 { rtmp:{ platform, ingestUrl, streamKeySet:true } }  %% key never echoed

    Note over Op,OL: Attach to production (existing assignment mechanism)
    Op->>OL: PATCH production outputAssignments += { outputId }
    OL->>DB: persist ProductionDoc.outputAssignments

    Note over Op,Plat: Activation — fan out to all assigned destinations
    Op->>OL: activate production (existing flow)
    OL->>DB: load production + assigned OutputDocs
    loop for each assigned rtmp OutputDoc
        OL->>OL: flow-generator: decrypt streamKey; compose ingestUrl + key; emit builtin.rtmp_output
        OL->>OL: link pgmFeedPad → :video_in, mainAudioSource → :audio_in_0 (as mpegtssrt does)
    end
    OL->>Strom: create + start flow (rtmp_output blocks carry composed URL at generation time)
    Strom->>Plat: RTMP(S) connect + publish program feed
    Plat-->>Strom: per-destination accept / refuse
    Note over Strom,OL: Per-destination refuse is currently strom#840 (unlinked pad → Internal data stream error).<br/>Clean per-destination status depends on strom#840 closing — see Open Question 3.
```

## Configuration

### Env vars

| Env var | Purpose | Default |
|---|---|---|
| `RTMP_STREAM_KEY_KEY` | AES-256 key (base64/hex, 32 bytes) for encrypting RTMP stream keys at rest. **Falls back to `SRT_PASSPHRASE_KEY` if unset**; fail-closed in production if neither is set and any RTMP destination has a stored key. **Whether to ship this dedicated key or reuse `SRT_PASSPHRASE_KEY` is Open Question 2.** | unset → falls back to `SRT_PASSPHRASE_KEY` |
| (reuses) `STROM_URL`, `SRT_PUBLIC_HOST` | Existing Strom/host config — unchanged (`src/config.ts:72, 142`). | — |

### Platform preset table

A small server-side table maps `platform` → ingest-URL template. It is **static config**, not
user-editable in v1, and stores no secret:

```jsonc
{
  "youtube":  { "ingestUrl": "rtmps://a.rtmp.youtube.com/live2" },
  "twitch":   { "ingestUrl": "rtmp://live.twitch.tv/app" },
  "facebook": { "ingestUrl": "rtmps://live-api-s.facebook.com:443/rtmp" }
}
```

The stream key is appended to the ingest URL only inside the flow generator at activation time, from
the decrypted key — never persisted composed, never logged. The exact per-platform URLs and the
encoder defaults each platform accepts must be **verified live** before implementation (Tier 1 in the
epic until a real end-to-end publish runs).

### Strom flow JSON shape

Strom ships `builtin.rtmp_output` (strom PR#827, v0.6.9). The flow generator emits one block per
assigned RTMP destination, wired exactly like the existing SRT output
(`flow-generator.ts:920-934`) — from the program feed pad and the main audio bus:

```jsonc
{
  "id": "b-out-<idSlug>-<endpointSuffix>",
  "block_definition_id": "builtin.rtmp_output",
  "name": "<output name>",
  "properties": {
    // composed at generation time from decrypted key; NEVER logged, NEVER persisted composed:
    "rtmp_url": "rtmps://a.rtmp.youtube.com/live2/<streamKey>"
    // encoder profile: constrained to what RTMP receivers accept (strom#783). The exact
    // property name/shape (whether set on rtmp_output or on the upstream builtin.videoenc
    // like Enc PGM at flow-generator.ts:212-222) is verified against strom#783's fix.
  },
  "position": { "x": COL_OUTPUT, "y": ROW_START + outputBlockIndex * ROW_H }
}
// links: { from: pgmFeedPad, to: "<id>:video_in" }, { from: mainAudioSource, to: "<id>:audio_in_0" }
```

> **Warning (strom PR#827 body).** The Strom flow-create handler logs the whole request body at
> `debug`. Since the composed `rtmp_url` contains the stream key, open-live must (a) never send a
> composed-key URL to a Strom instance that logs it without the same redaction open-live PR#316
> applied, and (b) redact `rtmp_url` in any open-live-side logging of the generated flow. This is an
> ADR-004 hard rule.

## Open Questions

Flag every genuine product/design decision below to `team-lead` before Phase 2 begins.

1. **Which platform presets ship in v1?** The epic names YouTube, Twitch, Facebook. Confirm all three
   ship in v1 (vs. a subset), and decide whether a `'custom'` / "other RTMP URL" preset ships
   alongside them or is deferred (the epic's headline flow is preset-only; a raw-URL destination
   reintroduces the manual-URL UX the epic explicitly moves away from, and widens the SSRF/secret
   surface). **Product decision — team-lead / @svensson00.**

2. **Credential-at-rest key: reuse `SRT_PASSPHRASE_KEY` or a dedicated `RTMP_STREAM_KEY_KEY`?**
   ADR-003 chose a dedicated `HTML_AUTH_KEY` (fallback to `SRT_PASSPHRASE_KEY`) for blast-radius
   isolation. A dedicated key is cleaner for rotation/isolation but is one more secret to provision;
   the SRT key is already wired and fail-closed. Recommend a dedicated `RTMP_STREAM_KEY_KEY` that
   falls back to `SRT_PASSPHRASE_KEY` when unset — but this is a security call for the
   `security-engineer` review. **Design/security decision.**

3. **How is per-destination failure surfaced, given strom#840?** Today's `OutputStatus` (issue #255)
   is derived **flow-level** — all outputs of a running production read `healthy` uniformly
   (`outputs.ts:51-55`), which cannot express "3 destinations up, 1 refused". A truthful
   per-destination status needs a per-output liveness signal from Strom, which is exactly blocked by
   strom#840 (a refused input unlinks the pad → `Internal data stream error` instead of a clean
   per-destination rejection). Decide the v1 behaviour: (a) ship flow-level status only and document
   the limitation, or (b) gate the per-destination-status UI on strom#840 closing. **Design decision,
   gated on strom#840 (OPEN).**

4. **Encoder defaults source of truth (ties to strom#783).** strom#783 (OPEN) is the fix that
   constrains `rtmp_output`'s default video profile to what RTMP receivers accept. Decide whether
   open-live sets an explicit encoder profile on the `builtin.rtmp_output` / upstream `builtin.videoenc`
   block, or relies on the strom#783 default once it lands. Implementation of the "no operator tuning"
   promise is gated on strom#783. **Design decision, gated on strom#783 (OPEN).**

## Risks

- **Stream-key exfiltration (the core risk).** The stream key is a bearer credential for the
  operator's platform channel. It lives on a shared server-side host and is composed into an
  `rtmp_url` handed to Strom. Mitigations designed in: encryption at rest (`srt-passphrase-crypto`),
  write-only/masked API (never returned, never in the `url`/`connect` fields), and the log-redaction
  hard rule (open-live PR#316 discipline) covering both open-live's flow logging and Strom's
  debug-logs-the-body behaviour (strom PR#827). Cautionary precedent: open-live-studio#10 (HIGH,
  CVSS 7.5) exposed a credential in plaintext to the browser via a public static asset — the v1
  stream-key UI must not repeat that (Studio companion #143 owns the UI side). **A
  `security-engineer` review of the key-handling flow is a hard gate before Phase 2** (ADR-004).
- **Upstream Strom dependencies are load-bearing and OPEN.** strom#783 (encoder profile not
  constrained) and strom#840 (refused input → `Internal data stream error`, no clean per-destination
  rejection) both gate a genuinely "easy" experience. Shipping the UI on top of an engine that
  silently fails on the first destination that refuses a codec turns "easy publishing" into a support
  burden — the epic's own disconfirming evidence. Implementation is blocked on these closing (epic
  kill-condition date 2026-10-16). Not duplicated here.
- **No live-inject primitive.** The composed `rtmp_url` (with key) must be present at
  flow-generation time; there is no running-element property PATCH in the Strom client (the same gap
  ADR-002/ADR-003 flagged, `src/lib/strom.ts` `elements` is list/get/pads only). Adding or rotating a
  destination on a live production requires a flow restart, not a hot update — keep v1 to
  activation-time composition.
- **No end-to-end publish has been proven.** Strom docs PR#776 claims YouTube/Twitch URL shapes are
  accepted, but nothing has been streamed to a real platform yet (Tier 1 in the epic). The preset URL
  table and encoder defaults must be verified live before implementation is considered done.
- **RTMP is outbound-connect, not a listener.** Unlike SRT-listener outputs, RTMP does not lease a
  port from `port-allocator`; the port-lease branch (`outputs.ts:135-171`) must be skipped for
  `'rtmp'` so a destination is not spuriously rejected for a port clash it never needs.
