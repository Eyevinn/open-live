# Repo patterns & non-obvious gotchas

Running notes on non-obvious behaviours in `open-live` that have bitten (or nearly bitten)
implementers. Add to this as you discover them — one short section per pattern.

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
