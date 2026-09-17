# Spec: Authenticated HTML sources

**Status: Accepted** (2026-09-17) — spec-only; implementation begins per the resolved v1 scope below
**Author:** architect agent
**Related issues:** Eyevinn/open-live-studio#129 (driving need — interactive login / MFA for HTML
sources; contributed proposal by @markusnygard). Distinct from, and **not** superseded by, the
event-forwarding surface (`docs/specs/html-source-event-forwarding.md` / ADR-002 / #187 →
#268) — @svensson00 confirmed on 2026-09-16 that authenticated HTML sources are a separate need
that "event-forwarding" does not cover.

> **Accepted (2026-09-17).** All five Open Questions are resolved (see "Resolved Decisions" below,
> which supersedes the original "Open Questions" list) and the mandatory `security-engineer` review
> (ADR-003 Decision 4) has PASSED with conditional sign-off. **v1 ships Design D (token-in-URL)
> only**; Designs B and C are deferred as an upstream-gated fast-follow because the `cefsrc`
> capability check (OQ2) came back CONFIRMED-NO. The security-review conditions are carried into
> Phase 2 (see ADR-003 Decision 4).

## Problem Statement

Open Live renders an HTML source (`streamType: 'html'`) by pointing a **shared, server-side
Chromium** at the source's `address`: on production activation the flow generator emits a `cefsrc`
element with `properties: { url: source.address }` feeding a `cefdemux`
(`src/lib/flow-generator.ts:538-545`), inside the Strom / GStreamer pipeline (see `docs/graphics.md`).
The URL is SSRF-validated by `graphicUrl()` (`src/lib/url-validation.ts:184-196`): http/https only,
no private/loopback/link-local hosts, no `file:`/`javascript:`/`data:text/html`.

That works for a **public** page. It does **not** work for a page behind a login: a private
dashboard, a scoreboard/timing portal, a stats provider, or anything gated by username/password +
MFA. The `cefsrc` navigates to the URL as an anonymous, cookie-less browser context, sees the
provider's login wall, and renders that instead of the graphic. There is today **no way** for an
operator to authenticate the source so the pipeline renders the logged-in view.

The contributed proposal in #129 solves this by having the operator log in through a **browser
popup in Studio**, then **forwarding the resulting live session cookies** to the server-side
browser. That premise is the security-sensitive core: **injecting a user's live session cookies
into a shared, server-side, long-lived browser** is exactly the kind of credential-blast-radius
problem this spec must reason about rather than assume.

> Note: the contributed proposal targets a `strom-html-renderer` / Puppeteer backend that **does
> not exist** in the org (verified 2026-09-16). The real renderer is Chromium `cefsrc` inside
> Strom. This spec is written against the real stack.

### Grounding (what exists today)

- HTML source model: `SourceDoc` with `streamType: 'html'` and a browser-URL `address`
  (`src/db/types.ts` StreamType at line 51; `src/routes/sources.ts:31-38`, create/patch schemas
  `SourceInput`/`SourcePatch` at `src/routes/sources.ts:57-79`).
- HTML source → render: `cefsrc` with `properties: { url }` (`src/lib/flow-generator.ts:538-545`).
  **The `cefsrc` receives its properties at flow-generation time**; the property is baked into the
  Strom flow before `flows.start`, not pushed to a running element.
- SSRF gate: `graphicUrl()` (`src/lib/url-validation.ts:184-196`), enforced on create/patch via
  `validateSourceAddress()` (`src/routes/sources.ts:31-38`) and mirrored in the Studio UI
  (`open-live-studio/src/pages/SetupPage/SourcesPanel.tsx:125-128`).
- **Secret-at-rest precedent — reuse this, do not reinvent.** SRT passphrases are already encrypted
  at rest with AES-256-GCM under a `SRT_PASSPHRASE_KEY` env var, with a self-describing `encv1:`
  wire prefix, "fail closed in production", and a hard "never log the plaintext or key" rule
  (`src/lib/srt-passphrase-crypto.ts:1-33`). This is the house pattern for a stored source secret
  and this spec builds on it.
- Strom client wraps flow/block operations but has **no element-property PATCH** for a running
  element (`elements` is `list/get/pads` only, `src/lib/strom.ts:805-809`) — the same constraint
  ADR-002 flagged. Consequently there is no "inject cookies into the running `cefsrc`" primitive;
  any credential material must be present **at flow-generation time**, before start.
- Per-gateway-token / hash-at-rest / shown-once precedent for a scoped secret: ADR-001.

## Scope

**In scope:**
1. A way to mark an HTML source as **authenticated** and attach the material needed for the
   server-side renderer to reach the logged-in view.
2. Server-side application of that material to the `cefsrc` render at flow-generation time, in an
   **isolated per-source browser profile** (no cross-source credential bleed in the shared browser).
3. Encryption-at-rest for any stored secret, reusing the `srt-passphrase-crypto` pattern; masking on
   API responses; never logging the plaintext.
4. Studio UI affordance to configure it on an HTML source.

**Explicitly out of scope:**
- The event-forwarding surface (ADR-002 / #268) — orthogonal; an authenticated source can still be
  event-forwarded once both ship.
- A full IdP / SSO integration or credential vault. This spec targets per-source credentials, not an
  org-wide secret manager (that would be its own epic).
- Solving MFA that requires a **fresh** interactive challenge on every render (e.g. hardware-key
  step-up with no refresh token). See Open Question 4.
- Rendering a page that forbids automation/headless entirely (bot-detection) — a provider policy
  problem, not something Open Live can bypass.

## Candidate designs evaluated

@svensson00 listed four candidates. All are evaluated here; the recommendation follows.

### A. Live cookie-forwarding (the #129 proposal)

Operator logs in via a Studio popup; the popup's live session cookies are captured and forwarded
(`POST /api/sources/:id/session`) into the shared server-side browser.

- **Pros:** matches how the operator already authenticates (their own browser, real MFA); no
  provider changes.
- **Cons (decisive):**
  - **Blast radius.** A live session cookie is a bearer credential for the operator's *whole* account
    at the provider. Placing it in a **shared, server-side, long-lived** browser means a compromise
    of that host (or another source in the same browser context) can exfiltrate a live, currently
    valid human session — strictly worse than the scoped, rotatable secrets ADR-001 was created to
    avoid.
  - **Capture is hard and fragile.** `HttpOnly` / `Secure` / `SameSite` cookies are, by design, not
    readable from the popup's JS (`document.cookie`), so `postMessage` cannot reliably harvest the
    real session cookie without a browser extension or a same-site relay — the #129 sketch quietly
    assumes readable cookies.
  - **No live-inject primitive.** There is no element-property PATCH on a running `cefsrc`
    (`src/lib/strom.ts:805-809`); "update the session live" is not a capability that exists.
  - **Lifetime mismatch.** Human sessions expire / get invalidated server-side mid-show; there is no
    refresh path, so the render silently drops back to the login wall on air.
- **Verdict:** **Reject as the primary mechanism.** Highest risk, hardest to capture correctly,
  worst lifetime story. Not fully abandoned — see Design C, which reuses the *isolation* idea
  without shipping a live human session into a shared browser.

### B. Per-source stored credentials (RECOMMENDED primary)

The operator stores, on the source, the credential the renderer needs — as one of a small typed set:
a **static header/token** (e.g. `Authorization: Bearer …`, an API key header) or, where a provider
supports it, a **long-lived service/refresh token**. Secrets are encrypted at rest
(`srt-passphrase-crypto` pattern), masked in API responses, and applied server-side by the renderer.

- **Pros:** scoped, rotatable, non-interactive; fits the existing encrypted-secret pattern exactly;
  present at flow-generation time so it needs **no** new live-inject primitive; a leaked service
  token is narrower and revocable vs. a live human session (the ADR-001 least-privilege posture).
- **Cons:** the provider must support a headless-usable credential (a service account / API token /
  static header). Interactive-only, MFA-gated dashboards with no token option are not covered by B
  alone (→ Design C / Open Question 4).
- **Verdict:** **Recommended** as the default, and the credential type this spec designs in detail.

### C. Persisted renderer profile (RECOMMENDED companion for interactive-login providers)

For providers that **only** offer interactive login (no token), the operator performs the login
**once** into a **named, isolated, server-side Chromium profile** (its own cookie jar / storage), and
that profile is **persisted** (encrypted) and re-attached to the `cefsrc` on every activation. This
is the #129 "capture a session" idea, but done as a **deliberately provisioned, isolated,
persistable profile** rather than shipping a live human cookie into a shared browser mid-show.

- **Pros:** handles interactive-login/MFA providers that B cannot; the profile is per-source-isolated
  (no cross-source bleed); persisted so it survives deactivate/reactivate; re-login is an explicit,
  auditable operator action, not a silent live forward.
- **Cons:** requires an interactive provisioning surface on the **server-side** browser (see Open
  Question 1 — where does that interactive login actually happen, given the renderer is `cefsrc`
  inside Strom on a GPU host, not a browser the operator can see?); the persisted profile still
  contains session material and must be encrypted, access-controlled, and expiry-aware; a session
  inside the profile can still expire and need re-provisioning.
- **Verdict:** **Recommended companion** to B for the interactive-only case, gated hard on the
  security review and on resolving Open Question 1 (the provisioning channel).

### D. Token-in-URL (RECOMMENDED zero-secret fast path, where supported)

Where the provider accepts a token as a URL parameter (signed/expiring links, share tokens), the
operator just uses that URL as the source `address` — **no new mechanism at all**, it already works
today through the existing sources CRUD.

- **Pros:** zero new code, zero new secret store; the existing `graphicUrl()` gate already applies.
- **Cons:** only some providers offer it; the token sits in the (encrypted-at-rest, but URL-shaped)
  `address` and may appear in provider access logs / referrers; expiry is the provider's.
- **Verdict:** **Document as the recommended first thing to try.** No spec work needed beyond calling
  it out; falls back to B, then C.

### Recommendation

The long-term target is a **decision ladder** (D → B → C, A rejected). But the OQ2 `cefsrc`
capability check came back **CONFIRMED-NO** (stock upstream gstcefsrc exposes neither a per-navigation
request header nor a per-source isolated user-data dir), so the ladder is delivered in two waves:

**v1 (ships now):**
1. **D (token-in-URL)** — already works on today's `cefsrc` (uses the existing `url` property, no new
   code); documented as the recommended first thing to try, with the operator trade-off that the token
   sits in the `address` (short-TTL + revocable, redacted in logs — see ADR-003 Decision 4 conditions).

**Upstream-gated fast-follow (deferred until gstcefsrc gains per-element headers + per-source
request-context/user-data-dir):**
2. **B (per-source stored credential)** — the intended default new mechanism; blocked on the header
   property.
3. **C (persisted isolated renderer profile)** — companion for interactive-login/MFA-only providers;
   blocked on the per-source user-data-dir property **and** a fresh security re-review (higher blast
   radius).

**A (live cookie-forwarding) is rejected outright** (not deferred) for the reasons above.

When B and C do land, both **must** render inside an **isolated per-source browser profile** so one
source's credentials never leak into another's context in the shared server-side browser.

## API Design

New material lives on the existing HTML `SourceDoc` and is managed through a small addition to the
sources surface. Following ADR-001's "secret shown/accepted, hash or ciphertext at rest, masked on
read" posture and the `srt-passphrase-crypto` masking already applied to SRT `address`.

### Data shape (request/response)

Add an optional `auth` object to an HTML source. Only present for `streamType: 'html'`.

```ts
// SourceDoc addition (see Data Model). All fields optional; absent = today's anonymous behaviour.
interface HtmlSourceAuth {
  // Discriminated by `mode`:
  mode: 'header' | 'profile';
  // mode: 'header'  → Design B. A static credential applied to the top-level navigation request.
  header?: {
    name: string;    // e.g. "Authorization"  (validated: token-header name, max 64)
    // value is WRITE-ONLY over the API: accepted on write, never returned; encrypted at rest.
    valueSet?: boolean; // read-only echo: whether a value is stored
  };
  // mode: 'profile' → Design C. A named, persisted, isolated renderer profile.
  profile?: {
    profileId: string;   // "hprof-<uuid>", server-issued
    status: 'unprovisioned' | 'provisioned' | 'expired';
    lastProvisionedAt?: string; // ISO 8601 UTC
  };
}
```

### REST — additive to the existing sources surface (`src/routes/sources.ts`)

| Method & path | Purpose | Notes |
|---|---|---|
| `PATCH /api/v1/sources/:id` | Set/replace `auth` on an HTML source | Extends the existing `SourcePatch` schema. `header.value` is **write-only**; response masks it (`valueSet: true`), mirroring how the SRT passphrase is masked (`srt-passphrase-crypto`). |
| `POST /api/v1/sources/:id/auth/rotate` | Rotate/clear the stored `header` secret | Mirrors `POST /api/v1/gateways/:id/rotate-token` (ADR-001). Accepts a new value or clears it. |
| `POST /api/v1/sources/:id/auth/profile/provision` | **(Design C, gated)** Begin an interactive-login provisioning session for the source's isolated renderer profile | Returns a one-time provisioning handle. The *how* of the interactive login channel is **Open Question 1** — this endpoint's body/response is deliberately left as a stub until that is decided and security-reviewed. |
| `GET /api/v1/sources/:id/auth/profile/status` | **(Design C)** Report `provisioned`/`expired`/`unprovisioned` | So Studio can warn before activation that a source's login has expired. |

Request/response for the header path (Design B), the concrete first slice:

```jsonc
// PATCH /api/v1/sources/:id   (body)
{
  "auth": {
    "mode": "header",
    "header": { "name": "Authorization", "value": "Bearer eyJ…" }  // value write-only
  }
}
// 200 response (value masked, never echoed)
{
  "id": "src-…", "streamType": "html", "address": "https://dashboard.example.com/",
  "auth": { "mode": "header", "header": { "name": "Authorization", "valueSet": true } }
}
```

### Error codes

Reuse the existing zod-validation → `400` path in `src/routes/sources.ts` (same `superRefine`
mechanism as `validateSourceAddress`), and the existing `404` for unknown source:

| Code | Case |
|---|---|
| `400` | `auth` present on a non-`html` source; unknown `mode`; header name fails the token-header allowlist; `header.value` over length; profile op on a `header`-mode source (or vice-versa). |
| `404` | Unknown `:id`. |
| `409` | Mutating `auth` on a source assigned to an **active** production (mirrors the graphics-delete `409` in `docs/graphics.md` and the source-in-use rules). |
| `501` | Design-C profile endpoints while Open Question 1 is unresolved (matches how `clip` `tams` is accepted at the type level but returns not-implemented — `src/db/types.ts` ClipReferenceTams note). |

**No new secret is ever returned** by any endpoint. `header.value` and profile session material are
write-only over the API, exactly like the SRT passphrase and the ADR-001 gateway token.

## Data Model

Additive field on `SourceDoc` (`src/db/types.ts`), present only for HTML sources:

```ts
// SourceDoc gains:
auth?: HtmlSourceAuth;   // see API shape above
```

**Encryption at rest (non-negotiable).** `auth.header.value` and any Design-C profile session
material are encrypted **before** the source doc is persisted and decrypted only just before being
handed to the renderer — reusing `src/lib/srt-passphrase-crypto.ts` (AES-256-GCM, `encv1:` wire
prefix, fail-closed in production). The plaintext secret is **never** stored, **never** logged, and
**never** returned by the API. The masking on read reuses the same "mask on API response" path the
SRT passphrase already uses.

**Key management.** Reuse `SRT_PASSPHRASE_KEY` **or** introduce a dedicated `HTML_AUTH_KEY` (Open
Question 3). A dedicated key is cleaner for blast-radius isolation and key rotation but is one more
secret to provision; the SRT key is already wired and fail-closed. Recommend a dedicated
`HTML_AUTH_KEY` that falls back to `SRT_PASSPHRASE_KEY` if unset, so existing deployments keep
working — but this is a security call.

### Migration

**Purely additive.** `auth` is optional; existing HTML sources (no `auth`) render exactly as today.
No CouchDB migration. The new REST fields are additive to `SourceInput`/`SourcePatch`. Studio clients
that ignore the field keep working. Design-C profile material is only ever created by an explicit
provisioning action, so nothing is created implicitly.

## Service Interactions

```mermaid
sequenceDiagram
    participant Op as Operator (Studio UI)
    participant OL as open-live (sources API + flow-generator)
    participant DB as CouchDB
    participant Strom
    participant HTML as HTML source (cefsrc, isolated profile)

    Note over Op,OL: Configure (Design B — stored header credential)
    Op->>OL: PATCH /sources/:id { auth: { mode:'header', header:{name,value} } }
    OL->>OL: validate (html source, header-name allowlist)
    OL->>OL: encrypt header.value (srt-passphrase-crypto, encv1:)
    OL->>DB: persist SourceDoc.auth (ciphertext only)
    OL-->>Op: 200 { auth.header.valueSet:true }  %% value never echoed

    Note over Op,HTML: Activation
    Op->>OL: activate production (existing flow)
    OL->>DB: load SourceDoc(s)
    OL->>OL: flow-generator: decrypt header.value; build cefsrc with isolated per-source profile + request header
    OL->>OL: re-run graphicUrl() on address (SSRF gate unchanged)
    OL->>Strom: create + start flow (cefsrc carries auth material at generation time)
    Strom->>HTML: navigate to address WITH credential, in isolated profile
    HTML-->>Strom: authenticated view renders into DSK/mixer

    Note over Op,HTML: Design C (interactive-login providers) — GATED on Open Question 1 + security review
    Op->>OL: POST /sources/:id/auth/profile/provision
    OL-->>Op: 501 until provisioning channel is decided + security-reviewed
```

## Configuration

| Env var | Purpose | Default |
|---|---|---|
| `HTML_AUTH_KEY` | AES-256 key (base64/hex, 32 bytes) for encrypting HTML-source auth material at rest. Falls back to `SRT_PASSPHRASE_KEY` if unset. Fail-closed in production if neither is set and any `auth` secret exists. | unset → falls back to `SRT_PASSPHRASE_KEY` |
| (reuses) `API_KEY` | Existing bearer gate on the sources REST surface — unchanged. | — |

No new Strom/GStreamer element is introduced. The `cefsrc` gains (a) an isolated per-source profile
(its own user-data dir / cookie jar) and (b) for Design B, a request header on the top-level
navigation. **Confirming that `cefsrc` can set a top-level-navigation request header and use an
isolated, persistable user-data dir is Open Question 2** — it must be verified against Strom's
`cefsrc` capabilities before B/C are committed (same "verify the transport primitive with the Strom
maintainers" discipline ADR-002 applied).

## Resolved Decisions (supersedes the original Open Questions)

All five were resolved on Eyevinn/open-live#291 by @svensson00 (product/PM decision authority) and
the pipeline's `cefsrc` investigation; the security-engineer review PASSED. Original question text is
retained for traceability.

1. **Interactive-login provisioning channel (Design C) → RESOLVED (a)/(b), net: out of v1.**
   @svensson00 chose to ship **B + D** and keep interactive-only-MFA providers (Design C) out of v1
   scope, tracked as a fast-follow gated on OQ2 and a provisioning-channel decision. Combined with
   OQ2 below, **v1 ships Design D only**; B and C are the upstream-gated fast-follow. A short-lived
   remote-interactive session into the render host is explicitly *not* a v1 surface.
2. **`cefsrc` capability check → RESOLVED: CONFIRMED-NO.** Strom builds stock, unpatched upstream
   `centricular/gstcefsrc` (`docker/gstcefsrc/Dockerfile`, pinned SHA `b633408`). Its installed
   properties are `url, gpu, chromium-debug-port, chrome-extra-flags, sandbox, listen-for-js-signals,
   js-flags, log-severity, cef-cache-location, max-video-framerate` — **no** per-navigation
   request-header property and **no** isolated persistable per-source user-data dir (only the
   deprecated *global* `cef-cache-location`; PR #671 adds a per-*instance*, not per-source, cache
   path). So Design B's header path and Design C's profile isolation both need an **upstream gstcefsrc
   change** first (a per-element request header + a per-source request-context/user-data-dir). Design D
   is unaffected — it uses the existing `url` property and works on today's `cefsrc`.
3. **Encryption key → RESOLVED: dedicated `HTML_AUTH_KEY`.** Falls back to `SRT_PASSPHRASE_KEY` when
   unset; fail-closed in production if neither is set and any `auth` secret exists. (Applies when B
   lands; D stores no separate secret.)
4. **Session-expiry UX → RESOLVED: passive `expired` status for v1.** Surface an `expired` status
   (e.g. on `GET .../auth/profile/status`, and on failed render for stored-header sources) so Studio
   can warn before activation; operator re-authenticates. Active/probing expiry detection is a later
   enhancement, not a v1 blocker.
5. **Live cookie-forwarding (Design A) → RESOLVED: rejected outright**, not merely deferred. The #129
   contribution is redirected toward the D (v1) and B/C (fast-follow) designs; A is not on the table.

**Security gate (ADR-003 Decision 4) → SATISFIED.** The `security-engineer` review of the B+D
session-handling flow returned PASS with conditional sign-off; the conditions are enumerated in
ADR-003 Decision 4 and carried into Phase 2.

## Risks

- **Credential blast radius (the core risk).** Any stored credential or persisted profile lives on a
  **shared, server-side, internet-egressing** host. A host compromise or an SSRF that reaches the
  renderer could exfiltrate it. Mitigations designed in: encryption at rest (`srt-passphrase-crypto`),
  write-only/masked API, per-source profile isolation, scoped/rotatable credentials over live human
  sessions (ADR-001 posture). **This is why a `security-engineer` review of the chosen
  session-handling flow is a hard gate before Phase 2** (see ADR-003).
- **SSRF gate must still apply.** The `address` still funnels through `graphicUrl()`
  (`src/lib/url-validation.ts:184`) at create/patch **and** at flow-generation; adding auth must not
  create a path that skips it (the #58 SSRF class). Non-negotiable.
- **No live-inject primitive.** Credentials must be present at flow-generation time
  (`src/lib/strom.ts:805-809` — no running-element PATCH). Any "update the session while on air"
  ambition would need the same Strom capability ADR-002 flagged as missing. Keep v1 to
  activation-time material.
- **Cross-source credential bleed.** Without per-source profile isolation, one source's cookies/tokens
  could leak into another's context in the shared browser. Profile isolation is mandatory, not
  optional.
- **Session expiry on air.** A token/profile that expires mid-show silently drops to the login wall in
  the programme feed. Tracked as Open Question 4; at minimum surface an `expired` status.
- **Provider anti-automation.** Some providers actively block headless/automated browsers; no Open
  Live mechanism can bypass that, and it should be documented as a known limitation, not a bug.
