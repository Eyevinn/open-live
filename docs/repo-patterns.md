# Repo patterns & non-obvious gotchas

Running notes on non-obvious behaviours in `open-live` that have bitten (or nearly bitten)
implementers. Add to this as you discover them — one short section per pattern.

## The SSRF `TRUSTED_SRT_HOSTS` matcher is spec-only — the shared matcher lives in `url-validation.ts`

ADR-009 and `docs/specs/storage-connections.md` §5 say the storage-endpoint SSRF guard "reuses
the `TRUSTED_SRT_HOSTS` matcher verbatim". That matcher does **not** exist in code yet —
`docs/specs/configurable-srt-private-host-allowlist.md` (issue #246) is still an unimplemented
spec, and `srtUrl()` has no `trustedSrtHosts` parameter. So #520 introduced the shared matcher
fresh: `isTrustedHost(hostname, trusted)` + `storageEndpointHost(endpoint, trusted)` in
`src/lib/url-validation.ts` (IPv4/IPv6 CIDR + IPv4-mapped-IPv6 canonicalisation, fail-closed on a
malformed entry, DNS names never match). When #246 is finally implemented, wire `srtUrl()`'s new
gate through `isTrustedHost` rather than writing a second matcher — the whole point of ADR-009
Decision 2 is one SSRF matching implementation to audit.

## Storage-connection secrets share the credential key, but `SRT_PASSPHRASE_KEY`-only deployments need `STORAGE_CONNECTION_KEY`

`storage-connection-crypto.ts` uses `KeySource { envVar: 'STORAGE_CONNECTION_KEY',
allowStoredKeyFallback: true }` — the SHARED credential-key family (ADR-009 Decision 1), like
SRT/HTML. Zero-config on OSC: no env key set → `ensureCredentialEncryptionKey()` generates the
shared stored key → storage secrets encrypt fine. **Gotcha:** `ensureCredentialEncryptionKey()`
early-returns `null` (no stored key generated) when `SRT_PASSPHRASE_KEY` is set. So a self-hosted
deployment that sets `SRT_PASSPHRASE_KEY` but NOT `STORAGE_CONNECTION_KEY` has no key for storage
secrets and fails closed in production. Such deployments must also set `STORAGE_CONNECTION_KEY`
(unlike HTML-auth, whose bespoke `loadHtmlAuthKey()` reads `SRT_PASSPHRASE_KEY` as a second env
fallback; the generic `KeySource` abstraction reads only its one `envVar`).

## `toApi()` spreads the whole doc — new secret-bearing fields leak by default

`src/routes/outputs.ts` `toApi()` builds its response with `const { _id, _rev, type, status, ...rest } = doc; { id: _id, ...rest }`. The `...rest` spread echoes **every** other field of the
stored `OutputDoc` verbatim. Any new structured field that carries a credential (e.g.
`rtmp.streamKeyEnc`) is therefore returned to the client unless you explicitly destructure it
out of the spread and re-project a key-free view.

Pattern: destructure the secret-bearing object out of `...rest` and add an explicit projection
(`rtmp` → `{ platform, ingestUrl, streamKeySet }`). Add a regression test asserting no response
body contains the ciphertext field name or the plaintext value (see
`src/__tests__/outputs-rtmp.test.ts`). The same caution applies to `SourceDoc`
(`authHeaderValueEnc` is kept off the `...rest` path deliberately — issue #314).

## A top-level route (e.g. `/metrics`) is NOT guarded by keeping it out of `AUTH_EXEMPT_PATHS`

The shared-key `onRequest` gate in `src/server.ts` only *guards* paths that start
with `/api/v1`, `/ws/`, `/documentation` **or `/metrics`** — every other path hits
the `return;` and is served **without auth**, exempt list or not. So for a
top-level route, keeping it out of `AUTH_EXEMPT_PATHS` is **necessary but not
sufficient**: it must also be added to that guarded-prefix check, or it answers
anonymously even when `API_KEY` is set. `GET /metrics` (issue #500, shared-GPU
usage) is the current example — it exposes per-tenant GPU usage, so it is both
absent from `AUTH_EXEMPT_PATHS` *and* listed in the prefix check, and a test
asserts `GET /metrics` with no token returns `401`
(`src/__tests__/metrics-route.test.ts`). A route under `/api/v1` (e.g.
`/api/v1/usage/gpu`) is guarded automatically — just do not add it to the exempt
set. When adding any new top-level path, extend the prefix check in the same
commit and cover the no-token path with a 401 test.

## Internal `ProductionDoc` accrual fields must be stripped from production responses

`activatedAt` and `gpuHours` (issue #500, shared-GPU metering) are internal
accrual state on `ProductionDoc`. `gpuHours` can hold up to
`GPU_USAGE_RETENTION_HOURS` keys (90 days ≈ 2160), so echoing the raw doc on the
production GET/list/PATCH responses would bloat and confuse existing clients — the
same `...doc` over-spread hazard as the `toApi()` section below. They are surfaced
**only** via `GET /api/v1/usage/gpu` and `GET /metrics`. The productions routes
pass every returned doc through `toProductionView()` (`src/routes/productions.ts`),
which destructures both fields out. Any new production response (or any new
internal-only `ProductionDoc` field) must go through the same projection; never
`reply.send(doc)` the raw production doc.

## `new URL()` on non-special schemes (rtmp/rtmps/srt) and IPv6 brackets

The WHATWG `URL` parser **does** parse the authority of non-special schemes when they use `//`
(e.g. `new URL('rtmp://live.twitch.tv/app').hostname === 'live.twitch.tv'`), so it is usable for
rtmp(s) validation. But an IPv6 literal host comes back **bracketed** (`new URL('rtmp://[::1]/').hostname === '[::1]'`). Strip the surrounding brackets (`.replace(/^\[|\]$/g, '')`) before
handing the host to `isPrivateHost()` — exactly as `httpUrlOnly()` already does — or a bracketed
loopback/link-local literal sails through the SSRF check. See `validateCustomIngestUrl()` in
`src/lib/rtmp.ts`.

## `srt-passphrase-crypto` key cache is now per-env-var

`src/lib/srt-passphrase-crypto.ts` was generalised (ADR-004) to load a key from an arbitrary
`KeySource` (which env var to read), so distinct at-rest credentials — `SRT_PASSPHRASE_KEY`,
`RTMP_CREDENTIALS_KEY` — reuse the same AES-256-GCM / `encv1:` / fail-closed-in-prod core. The
internal key cache is a `Map` keyed by env-var name; `resetKeyCache()` clears **all** sources.
Dedicated credential keys (RTMP) deliberately have **no** fallback to `SRT_PASSPHRASE_KEY`
(ADR-004 Resolved Decision 2) — do not add one, or a stream-key rotation would be coupled to the
SRT passphrase key.

## The guest-invite signing key is backend-generated and stored, not just an env var

Guest calling is on by default (issue #391). The signing key is resolved via
`src/lib/guest-signing-key.ts`, NOT by reading `config.guestInviteSecret` directly:

- `getGuestSigningKey()` returns `config.guestInviteSecret ?? <cached stored key>`. Routes that
  sign/verify invite tokens must call `getGuestSigningKey()`, never `config.guestInviteSecret`
  (the env var is now only an optional override and is usually unset).
- `isGuestCallingEnabled()` (`src/config.ts`) delegates to `isGuestSigningKeyAvailable()`, so it is
  true once *either* the env override or the stored key is present.
- `ensureGuestSigningKey()` runs once at startup (`src/main.ts`, after `connectDb()`). It is a
  no-op when the env override is set; otherwise it reads the single fixed-id doc
  (`GUEST_SIGNING_KEY_DOC_ID = 'guest-invite-signing-key'`) or creates it if absent. A
  concurrent-create `409` is handled by re-reading the winner's key, so all processes converge on
  one key. The key is cached in-memory so the route hot path stays synchronous.
- `config.ts` imports `guest-signing-key.ts`, which imports `db/index.ts`, which imports
  `config.ts` — an intentional ESM cycle. It is safe only because no binding is used at module-eval
  time; keep it that way (do not call these at top level).
- The stored key lives in `GuestSigningKeyDoc.signingSecret`. The `secret` substring makes it
  redacted by `log-redact.ts`; `server.ts` also lists `signingSecret` / `*.signingSecret` in the
  Fastify logger redact paths. Never add a route that returns the doc.

## The credential encryption key is backend-generated and stored, not just an env var

On OSC no `SRT_PASSPHRASE_KEY` / `HTML_AUTH_KEY` is provisioned, so storing an SRT passphrase or
an authenticated-HTML-source credential used to fail closed with a 503 ("Credential storage is
not configured"). Mirroring the guest signing key (#391), the backend now generates and stores a
credential key itself (issue #438), via `src/lib/credential-encryption-key.ts`:

- `ensureCredentialEncryptionKey()` runs once at startup (`src/main.ts`, after `connectDb()`). It
  reads the single fixed-id doc (`CREDENTIAL_ENCRYPTION_KEY_DOC_ID = 'credential-encryption-key'`)
  or creates it (32-byte AES-256, base64) if absent, decodes it to a Buffer and caches it. A
  concurrent-create `409` is handled by re-reading the winner's key. It is a **no-op that returns
  `null`** when `SRT_PASSPHRASE_KEY` is set — that env var is the shared base key both the SRT and
  HTML crypto already resolve to, so a stored key is unnecessary and the DB is never touched (keeps
  self-hosted deployments unchanged).
- The crypto modules consume it as a *fallback*, not a replacement for the env override. In
  `srt-passphrase-crypto.ts`, `loadKey()` falls back to a stored key only for a `KeySource` with
  `allowStoredKeyFallback: true`. The fallback key comes from `source.storedKeyProvider` when the
  source sets one, otherwise from the shared `getStoredCredentialKey()`. `SRT_PASSPHRASE_KEY_SOURCE`
  sets `allowStoredKeyFallback: true` with no provider, so it uses the shared credential key.
  `html-auth-crypto.ts` `loadHtmlAuthKey()` falls back to the same shared stored key when neither
  `HTML_AUTH_KEY` nor `SRT_PASSPHRASE_KEY` is set.
- **RTMP has its OWN dedicated stored key — it never reuses the shared credential key** (issue
  #447, ADR-004 Resolved Decision 2, which requires a dedicated `RTMP_CREDENTIALS_KEY` with no
  reuse of the SRT key). `RTMP_CREDENTIALS_KEY_SOURCE` sets `allowStoredKeyFallback: true` with
  `storedKeyProvider: getStoredRtmpCredentialKey` (`src/lib/rtmp-credential-key.ts`), a parallel
  module that generates/stores a SEPARATE key under its OWN doc id
  (`RTMP_CREDENTIAL_KEY_DOC_ID = 'rtmp-credentials-key'`, distinct from
  `CREDENTIAL_ENCRYPTION_KEY_DOC_ID`). `ensureRtmpCredentialKey()` runs at startup right after
  `ensureCredentialEncryptionKey()` and no-ops when `RTMP_CREDENTIALS_KEY` (env) is set. The two key
  families never cross: SRT/HTML fall back to the credential key, RTMP falls back to the RTMP key.
- Resolution order per kind: env override wins, then that kind's stored key, then fail-closed-in-prod /
  loud-plaintext-in-dev as before. Env overrides always win, so self-hosted setups are unchanged.
- The stored keys live in `CredentialEncryptionKeyDoc.encryptionSecret` and
  `RtmpCredentialKeyDoc.encryptionSecret`. The `secret` substring makes them redacted by
  `log-redact.ts`; `server.ts` also lists `encryptionSecret` / `*.encryptionSecret` in the Fastify
  logger redact paths (the field name is shared, so both docs are covered). Never add a route that
  returns either doc.
- `credential-encryption-key.ts` / `rtmp-credential-key.ts` import `db/index.ts` (→ `config.ts`) —
  the same intentional ESM cycle as `guest-signing-key.ts`; it is safe only because no binding is
  used at module-eval time. `getStoredCredentialKey()` / `getStoredRtmpCredentialKey()` are
  synchronous so the crypto hot path stays synchronous.

## A new `/api/v1/guests/:inviteId/...` route needs the `isGuestTokenAuthedPath` allowlist

Guest-facing routes authenticate with the per-invite HMAC token *inside the handler*
(`resolveGuestSession` / `verifyGuestInviteToken`), not the shared `API_KEY`. The shared-key
`onRequest` gate in `src/server.ts` blocks every `/api/v1` request that is neither a valid
`API_KEY` nor an eligible guest token, so a new guest route 401s before its handler ever runs
unless its path is added to the `isGuestTokenAuthedPath()` regex (the explicit exemption list).
When you add a guest route, extend that regex and keep it anchored (`$`) and narrow — it is a
security boundary, not a convenience. This is distinct from `isGuestEligibleWhipReturnPath()`,
which is the *crew* `/api/v1/productions/...` WHIP/return paths where a guest token is *also*
accepted (setting `req.guestScope`); guest-scoped `/api/v1/guests/...` aliases use the
`isGuestTokenAuthedPath` exemption instead and verify the token themselves.

Why two mechanisms at all: on OSC the ingress gate only passes `^/guest` and `^/api/v1/guests`
(osaas-app#6143), so WHIP/WHEP that a guest browser must reach has to live under
`/api/v1/guests/:inviteId/...` (issue #423). The mixerInput for those aliases comes from the
guest's LIVE session, never the URL or the invite — a left guest's token must not be able to act
on the slot a later guest now holds.

## RTMP outputs never populate `OutputDoc.url` and are never in `SRT_OUTPUT_TYPES`

An `outputType: 'rtmp'` destination keeps its ingest URL + key in the structured `rtmp` object,
never in `url`. Keep `'rtmp'` out of `SRT_OUTPUT_TYPES` so the derived `connect` field
(`outputs.ts`) is never computed from a key-bearing URL, and skip the SRT listener port-lease
branch for it (RTMP is an outbound connect, not a listener). The stream key is decrypted and
composed into `rtmp_url` **only** in the flow generator at activation time, never persisted
composed, and only ever logged through `safeFlowProjection()` (which strips all block
properties).

## A rejected Strom `/transition` must roll back the whole switch, not just the PiP announce

In `ws/controller.ts`, CUT/TRANSITION/TAKE (interactive and macro) mutate the tally, the PiP
maps (`pgmPip`/`pvwPip`/`pvwBeforePip`/`pgmBg`) and the persisted doc, and broadcast `TALLY`,
**before** awaiting Strom's `/transition`. #355/#370 only deferred the *PIP_STATE displacement
broadcast + preview restore* until the transition succeeded — the tally, the map mutations and
the persisted doc were still left on the new value when Strom rejected the cut, so clients kept
showing the new source while Strom aired the old one (#430). Any new switch path must snapshot
state before mutating (`snapshotSwitchState`) and, on a `false` from `stromTransition` (or a
caught Strom error in the TAKE PiP branches), call `restoreSwitchState` to roll back tally + the
four PiP maps + the persisted doc and re-broadcast `TALLY`/`PIP_STATE`, then notify the operator
(`notifySwitchRejected` — NACK with a cmdId, else ERROR; macro paths `throw` so the loop reports
`MACRO_ERROR`). Never ACK `executed` on a rejected switch.

## Every flow-teardown path must force-stop the meter/clip relays with the dying flow id

`runActivationFlow` persists `stromFlowId` on the doc while status is still `activating`, and a
controller connecting in that window starts the meter and clip relays on that flow (the connect
path keys only off `connectDoc.stromFlowId`). The relays are ref-counted and only rebind off a
flow that was *recorded as retired* (`forceStop{Meter,Clip}Relay(id, flowId)`, #433) — a plain
`stop`/new `start` on a live flow just ref-counts. So **any** path that tears a flow down must call
both `forceStopMeterRelay`/`forceStopClipRelay` with that flow id, exactly like `deactivate`:
otherwise the relays stay bound to the dead flow and the next activation only ref-counts the stale
relay, starving every client of METER_DATA / LOUDNESS_DATA / reactive CLIP_STATE until all
controllers disconnect. This bit the activation-failure and abort paths in `runActivationFlow`
(#435), which tore down the flow + reset the doc but never touched the relays. The paths are now
covered by `forceStopRelaysForDyingFlow()` (a local closure over the run's `stromFlowId`), invoked
from the catch failure path and every `signal.aborted` early-return. Idle auto-deactivate has the
same obligation (`idle-watchdog.ts`). `forceStop*` is idempotent and a no-op when no relay exists,
so calling it defensively on abort (where `deactivate` also stops them) is safe.

## Connect-snapshot broadcasts are buffered per-socket until SNAPSHOT_END

The controller WS (`src/ws/controller.ts`, `controllerWs`) `subscribe()`s a socket to broadcasts
*before* it builds the connect snapshot (HELLO … per-point `socket.send` frames … SNAPSHOT_END),
and the snapshot `await`s Strom/CouchDB in the middle. So a `broadcast()` fired during that window
used to reach the socket interleaved between snapshot frames and indistinguishable from them —
most snapshot frames carry no `seq`/`ts`, but some (`GRAPHIC_STATE`, `RETURN_STATE`, the connect
`TALLY`) stamp both from the same `nextSeq(id)` `broadcast()` uses, so `seq` alone could not tell
them apart. Worse, a *staler* snapshot frame emitted after a newer live broadcast could overwrite
it on the client (#456).

Fix (in `tally.service.ts`, not per-frame tagging): `beginSnapshot(ws)` is called right after
`subscribe()` (before `notifySubscriberJoin`, which can itself broadcast). While a socket is
"snapshotting", `broadcast()` pushes its copy into a per-socket buffer instead of sending. The
whole snapshot body runs inside a `try`; the `finally` calls `endSnapshot(ws)` — which flushes the
buffer *in order* — and then sends SNAPSHOT_END. Invariants that keep this correct:

- `beginSnapshot` must be before any code path that can `broadcast()`, or a live frame slips
  through unbuffered ahead of HELLO.
- `endSnapshot` must run with **no `await` before the SNAPSHOT_END send** (both live in the same
  synchronous `finally` tail) so a later broadcast cannot overtake SNAPSHOT_END.
- Flushing *before* SNAPSHOT_END (not after) is deliberate: buffered broadcasts were allocated
  their `seq` during the window, so they are all `<= currentSeq(id)` = SNAPSHOT_END's `seq`. A
  client resumes live events at `seq > snapshotEnd.seq`; delivering them inside the snapshot phase
  keeps the contract (`docs/specs/automation-control-contract.md` §4) intact and means the final
  applied state is snapshot-then-latest, never a stale frame clobbering a newer one.
- The `try/finally` also guarantees SNAPSHOT_END (and the flush) on a throw after HELLO — without
  it a thrown snapshot would leave the socket stuck buffering and it would never get another
  broadcast (strictly worse than the original bug). A *hung* Strom call is still unbounded; that is
  out of scope (no new timeouts were added beyond what the surrounding code already uses).
- `unsubscribe()` drops the buffer, so a socket closing mid-snapshot does not leak or deliver late;
  `endSnapshot`/the SNAPSHOT_END send are both guarded by `readyState === OPEN`.

## A guest slot's multiview label must be set to `Guest N` at flow build — the source name is not enough

A guest slot is a source assignment carrying a `returnFeed` (same definition as
`guestSlotAssignment` in `routes/guests.ts` and `assignReturnBuses`). Its WHIP source is the
virtual `Whip` (`audio-channels.ts`, name `WHIP Input`) or a nameless WHIP input, so the
vision-mixer `input_${padIndex}_label` loop in `flow-generator.ts` — which otherwise writes the
source name — would either emit the generic `WHIP Input` or leave the label unset, and Strom's
`parse_input_labels` then falls back to its default `In N+1`. Either way the multiviewer disagrees
with the Studio controller, which labels the same slots `Guest 1`/`Guest 2` (open-live-studio#171,
issue #458). So for a WHIP guest slot the generator now emits a `Guest N` label that takes
**precedence** over the generic source name. The numbering must match the controller exactly:
`returnFeed` assignments ordered by **trailing pad index DESCENDING** (Studio allocates guest
slots from the top of the mixer-input range down — `video_in_15` is Guest 1 — see
`guestSlotMixerInput`/`guestSlotIndex` in open-live-studio), numbered `1..N`. Note this is NOT the
ascending `mixerInput.localeCompare` order the audio-channel / return-bus numbering uses, so do not
reuse `returnBuses` order for the label. The label is a non-live creation-time property; updating
it to the joined guest's invite label live is a separate stretch goal (needs Strom live-label
support).

The same precedence must be repeated in the `GET /audio` route (`src/routes/audio.ts`, issue
#464): the generator writes the guest slot's `ch{N}_label = Guest N` on the audio mixer block, but
the route resolved each strip's label from `loadAudioChannels` FIRST — and a WHIP guest slot
resolves to the virtual `Whip` source's name `WHIP Input`, so a naive
`audioChannelNameMap.get(i) ?? ch{N}_label` short-circuits and every guest strip reads
`WHIP Input`. So the route detects a WHIP guest slot the same way the generator does (an
assignment carrying a `returnFeed` whose resolved source has `streamType === 'whip'`) and, for
those channels only, prefers the flow's `ch{N}_label` over the resolved name; every non-guest
channel keeps resolved-name-first. The flow-generator property test is not enough on its own — a
guest-slot label regression only shows at the endpoint, so cover it with an endpoint-level test
(`src/__tests__/audio-guest-slot-labels.test.ts` generates a real flow, serves it from a throwaway
Strom, and asserts `GET /audio` returns `Guest N`).

## The controller WS reads `?mode` by exact key — confusable keys must be rejected, not ignored

The controller WebSocket route (`src/ws/controller.ts`, `controllerWs`) decides watch-only vs
operator from `req.query.mode`. Fastify's default querystring parser (node `querystring`) does
**no** case-folding or bracket-array expansion, so `?Mode=watch` parses to the key `Mode` and
`?mode[]=watch` to the literal key `mode[]` — neither populates `req.query.mode`. Left alone, a
passive client (e.g. a tally logger) that typo'd the key silently opens as an **operator** and
runs the first-connect audio-mixer reset (#424). The route therefore rejects any query key that
is confusable with `mode` — a case variant or array-bracket form, matched by
`/^mode(\[.*\])?$/i` with the exact `mode` key excluded — with an `ERROR` frame + WS close 1008,
*before* the unknown-value check. Deliberately **not** `additionalProperties:false`: genuinely
unrelated params (cache-busters, etc.) must still work, so only `mode`-confusable keys are
rejected. An exact `mode` key keeps its existing value check (`watch` → watch-only, anything
else → ERROR + 1008).

## Audio mix changes are broadcast twice: optimistic move, then `applied: true` after Strom

The audio paths in `src/ws/controller.ts` (`AUDIO_SET` volume, `AUX_SEND_SET`, `AUX_MASTER_SET`,
`GRP_SEND_SET`, `GRP_MASTER_SET`, `MONITOR_SET`, `SOURCE_OFFSET_SET`) **debounce** the Strom write
(~150 ms) but broadcast the operator's move immediately for UI responsiveness. So during a drag
every step is broadcast, while Strom only ever receives the final value when the fader stops
(#453). The convention (issue #453): once the debounced write to Strom *succeeds*, re-broadcast the
value that was written in the same `*_STATE` shape, with an added **`applied: true`** flag, so all
clients converge on what actually reached Strom. The flag is additive — clients that ignore it keep
working. Any new debounced audio path must emit the same confirmation on success. Do **not** emit
`applied: true` on failure/refusal: refusal handling is tracked separately (#394), and the existing
`StromPropertiesRejectedError` branch in the volume path broadcasts Strom's *actual* level
(without `applied`), which must stay untouched. The REST route
`PATCH /api/v1/productions/:id/audio/:elementId` (`src/routes/audio.ts`) is **not** debounced but
previously broadcast nothing; it now emits the same `AUDIO_STATE { ..., applied: true }` after its
write so a REST mix change no longer leaves live WS clients stale. `broadcast()`
(`src/services/tally.service.ts`) takes `message: unknown`, so there is no outgoing-message union
to extend — the extra field is accepted as-is.

## Audio processing: one Strom mixer property is construction-time (`chN_hpf_enabled`)

The `builtin.mixer` audio processing (issue #527, OL-25) maps all stages to **live** block
properties **except** the per-channel HPF on/off flag `chN_hpf_enabled`, which Strom marks
`live: false` (`backend/src/blocks/builtin/mixer/definition.rs:674-690` @`8fce2ee`). A live
`PATCH .../blocks/{id}/properties` carrying it is **rejected** (lands in the `rejected` map →
`StromPropertiesRejectedError`), exactly like `chN_aux{M}_pre` (#395). So `src/lib/audio-processing.ts`
splits a stage's Strom props into `{ live, construct }`: `stageToStromProps` puts only
`chN_hpf_enabled` in `construct`. The WS/REST handlers write **only `live`** to the running flow;
the construct key is persisted on `ProductionDoc.audioProcessing` and applied by
`flow-generator.ts` at **build** time (`buildStromPropsFromStore`), so HPF on/off **takes effect on
next activation** — documented as such in the contract. The HPF *cutoff* (`chN_hpf_freq`) is live.

Related: the connect-time mixer reset (`src/ws/controller.ts`, first-connect init) only writes
`chN_fader`/`chN_mute`/`chN_to_main`/`main_fader` — it never touches processing keys, so persisted
processing is **naturally excluded** from the reset. On first connect it is **re-applied** (live
keys only) and `AUDIO_PROC_STATE` is replayed for each stored stage. Ranges mirror Strom exactly
(cross-checked against `frontend/src/mixer/detail.rs` slider ranges, not just the backend
descriptions, which round e.g. attack to `0-200` where the UI enforces `0.1-200`).

## Controller WS rate-limit drops are coalesced and idempotent setters are replayed

The per-connection WS rate limiter (`src/ws/controller.ts`, `checkRateLimit`, 20 msg/s general +
5/s expensive) used to emit one `ERROR`/`NACK` per dropped message and log nothing, so an
unthrottled slider drag (~100 `SET_EFFECT`/s) became a storm of toasts and a dropped *final*
slider position left the effect stale (#469). `handleRateLimitedMessage` now opens a single
**drop window** (one `RATE_LIMIT_WINDOW_MS` timer, scheduled on the first drop) in which:

- correlated commands (those carrying a `cmdId`) still get their **own** `NACK` — the automation
  contract (§2) requires every `cmdId` to resolve, so these are deliberately NOT folded into the
  coalesced frame;
- all *uncorrelated* drops share **one** `ERROR` frame (`errorSentThisWindow`);
- the latest value of each idempotent setter is retained per target in `pendingSetters`, keyed by
  `coalesceKey(msg)` (`SET_EFFECT` by target, `AUDIO_SET`/`AUX_*`/`GRP_*`/`MONITOR_SET`/
  `SOURCE_*_OFFSET_SET` by element/bus). `coalesceKey` returns `null` for commands and anything
  whose intermediate values matter — those keep the old drop-outright semantics.

When the window drains (`drainDropWindow`) it logs the aggregate count once at `warn` and
**re-enters `handleMessage`** for each retained setter. Non-obvious invariants:

- The drain **must** receive the full `ControllerMsgCtx` (not just the `RateLimitState`), because
  the replayed `AUDIO_SET` relies on `ctx.audioBlockId` resolved at connect time; passing a bare
  ctx would force a redundant flow fetch.
- Replay runs through the *now-drained* sliding window, so if a burst is still saturating the
  limiter the replay is simply re-dropped and re-retained — the final value still converges across
  successive windows rather than being lost.
- The drain timer is `unref()`ed so a pending window never keeps the process alive, and
  `createRateLimitState()` (not an inline literal) must be used to seed the state or the new
  `pendingSetters`/counter fields are undefined. Tests drive the window with
  `vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS)` — a plain `setSystemTime` jump does **not**
  fire the drain timer.

## Strom ends a WHIP publish only on the session RESOURCE, never the endpoint

Strom routes `DELETE` only on the WHIP session resource
(`/whip/{endpoint_id}/resource/{resource_id}`), not on the bare endpoint URL
`resolveStromWhipUrl()` (`src/routes/whip.ts`) builds (`/whip/{endpoint_id}`). A `DELETE` on the
endpoint returns but does **not** end the session — Strom keeps the publisher alive until its 10 s
inactivity reaper. So guest leave/kick appeared to work (204) yet a rejoining guest could be off
air for tens of seconds (#467). The resource URL is only knowable from the `Location` header Strom
returns on the WHIP offer POST; the proxy (`proxyWhipOffer`) rewrites that for the client but the
server must also *keep* it. It is now persisted on the guest session as
`GuestSessionDoc.whipSessionUrl` (via `proxyWhipOffer`'s `onStromLocation` sink →
`persistGuestWhipSessionUrl`, guest POST path only — crew teardown stays client-driven through the
proxy), and `teardownGuestWhip` (`src/routes/guests.ts`) DELETEs **that** URL, not the endpoint.
Any new server-side WHIP teardown must target the stored session resource, re-check it is
`assertSameStromOrigin` before the DELETE (the stored Location is defence-in-depth untrusted), and
**log** a non-2xx/network failure instead of swallowing it — a swallowed teardown is an invisible
lingering session. `whipSessionUrl` is internal: it is destructured out of `sessionToApi` so it
never reaches operator clients, and it is absent on return-only slots / before the first publish
(teardown no-ops then) and stale after a reconnect until the next offer overwrites it.

## Ending a guest's WHIP session does NOT clear the slot picture — black it, and restore it on join

Tearing down a guest's WHIP session (previous section, #467) stops the *publisher*, but the
`whip_input` block holds its **last decoded frame**, so the vision mixer keeps compositing the
dropped guest's frozen frame onto PGM and the multiview (#493). There is no `whip_input` "go
black" property (the block exposes only `endpoint_id`), so the clear is done one level down, on
the vision mixer: `input_{N}_alpha` is a LIVE per-input property (0.0–1.0, strom-block-config.md)
set via the same `updateBlockProperties` channel as the live `input_{N}_label` (#466). On
leave/kick/revoke `clearGuestSlotPicture` (`src/lib/guest-slot-label.ts`) pushes that slot input's
alpha to **0** (best-effort, never throws — same contract as the label reset; an older Strom that
rejects the property just keeps the frame). The alpha targets the **COMPACT** pad
(`mixerInputToStromPad`, #463), exactly like the label.

Non-obvious invariant: alpha 0 is sticky on a live flow, so the **join path must restore it to 1**
(`restoreGuestSlotPicture`) — otherwise the next guest (or a rejoin) on the same slot of the same
live flow is composited at alpha 0 and stays **invisible**. The two live writes are coupled at the
route helper `resetGuestSlot` (label reset + picture black on teardown) and in the join handler
(label set + picture restore); keep both halves together when adding a new teardown/join path.
Numeric *block* properties go out as plain JSON (`input_N_alpha: 0` serialises to `0`), which Strom
accepts — the float-coercion `"value":N→N.0` hack in `StromClient.request()` only rewrites the
`value` key of element/pad writes, not the `properties` map (the existing `ch{N}_fader = 1.0`
block-property writes rely on the same). Known gap: this blacks the composited/PGM output for
certain; whether Strom also dims the raw multiview tile for a 0-alpha input is a Strom-internal
detail not verifiable from this repo — if a frozen *multiview* tile persists, that is a Strom-side
follow-up, not a backend bug.

## Shared-GPU metering has one predicate — never read `process.env.GPU_POOL` directly

Whether an instance is metered (and gated at zero balance, `production-gate.ts`) is
`isGpuMeteringEnabled()` = `Boolean(config.gpuPool)`, and `config.gpuPool` is *resolved*, not
the raw env: explicit `GPU_POOL` wins, otherwise `resolveGpuMetering()`
(`src/lib/gpu-metering-defaults.ts`, issue #537) derives a pool for an OSC-managed instance
(`OSC_HOSTNAME`) on the platform shared Strom (`https://strom-se-stoNN.osaas.io:8080`), always
(there is no switch, #547). A new check that reads `process.env.GPU_POOL` would silently disagree
with the meter on every managed shared-Strom instance, which has no `GPU_POOL`. On a platform
match the class is always `shared` (`GPU_CLASS` is ignored there), so never derive "billable"
from the raw `GPU_CLASS` env either. Note that WHATWG `URL` normalises `:443` on
an `https` URL to `port === ''`, so the port allowlist treats it like "no port".

## Shared-GPU accrual never starts from raw `activatedAt` — use `accrualStartMs()`

`activatedAt` is written on every activation even with metering off and survives a restart
(reconcile), so a production live across the restart that enables metering would be
back-charged if accrual started at `activatedAt`. Every `computeHourBuckets` caller in
`src/services/gpu-usage.ts` passes `accrualStartMs(activatedAtMs)` = `max(activatedAt, enabledAt)`
(issue #535). `enabledAt` is the `gpu-metering-state` marker doc, written once by
`startGpuUsageSweep` and never overwritten; with the DB down the floor is the in-memory sweep
start. A new accrual path that skips `accrualStartMs()` reintroduces the back-charge. The floor is
`null` (no clamp) only when the sweep never started, which is why unit tests that call the accrual
functions directly see raw `activatedAt`.

## The recording upload target is the activation snapshot, not the current assignments

Deactivate uploads a recording to `ProductionDoc.recording` (`{ outputId, connectionId?,
startedAt }`), written at activation next to `recorderBlockId` (issue #534). Do not re-read
`outputAssignments` at deactivate to find the target: assignments can change on a live production
and only take effect at the next activation, so re-reading would send (or silently drop) the
running recording's upload somewhere else. `firstRecordingOutput()` is only the fallback for a
production activated before the snapshot existed. Every deactivate with a recorder writes
`lastRecordingUpload` through `writeDeactivatedDoc` (not a separate write before the upload: the
uploader's `isStillRecording` guard compares `_rev`, and an extra write would make it skip the
delete-after-upload pass). Extra signed S3 query params such as `response-content-disposition`
sort after the `X-Amz-*` ones (lowercase after uppercase), so `presignGetUrl` appends them last;
the result was checked against botocore's `S3SigV4QueryAuth`.

## Recording segments are streamed, never buffered whole

`uploadRecordings` pipes the Strom media download straight into `uploadStream` (issue #552): it
buffers one 16 MiB part, uses a single PutObject if the stream ends inside it, and otherwise sends
one UploadPart at a time, pulling the next part only after the previous one is acknowledged. Do
not reintroduce `res.arrayBuffer()` or collect the chunks for a later step: anything that needs
the bytes (the MP4 duration) must consume them as they pass, as `Mp4DurationScanner` does by
following top-level box headers and keeping only `moov` (capped at `MOOV_MAX_BYTES`; over the cap
it reports no duration). Strom's media download has no Range support, so the file can only be read
once, front to back. `new Uint8Array(buffer)` copies; `signedS3Request` passes a view
(`new Uint8Array(buf.buffer, buf.byteOffset, buf.length)`) so a part is not duplicated in memory.

## Every guest-ending path must broadcast `GUEST_STATE` — including invite revoke

Studio re-fetches `GET /audio` for the authoritative strip label on every `GUEST_STATE`, and
nothing else tells the *other* connected operator clients that a slot was freed. Leave and kick
broadcast `left`; revoking an invite (`DELETE .../guests/invites/:inviteId`) did not, so only the
revoking client reverted its strip (issue #561). Revoke now broadcasts `left` with no `label` per
live session of the invite, or — when nobody had joined — one event keyed by the invite id that
still carries the pinned `mixerInput`. A new guest-ending path needs the same broadcast. In
`guests-routes.test.ts`, seed sessions straight into `sessionsStore` instead of calling
`POST /guests/:inviteId/join`: that route is rate-limited to 10/min per client and the suite is
already close to the limit, so extra joins fail with 429 and an undefined `guestId`.
