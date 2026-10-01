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

## RTMP outputs never populate `OutputDoc.url` and are never in `SRT_OUTPUT_TYPES`

An `outputType: 'rtmp'` destination keeps its ingest URL + key in the structured `rtmp` object,
never in `url`. Keep `'rtmp'` out of `SRT_OUTPUT_TYPES` so the derived `connect` field
(`outputs.ts`) is never computed from a key-bearing URL, and skip the SRT listener port-lease
branch for it (RTMP is an outbound connect, not a listener). The stream key is decrypted and
composed into `rtmp_url` **only** in the flow generator at activation time, never persisted
composed, and only ever logged through `safeFlowProjection()` (which strips all block
properties).
