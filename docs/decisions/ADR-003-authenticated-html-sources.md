# ADR-003: Authenticated HTML sources use scoped, encrypted per-source credentials — not live cookie-forwarding

**Date**: 2026-09-16 (Accepted 2026-09-17)
**Status**: Accepted

> **Resolution (2026-09-17).** All five spec Open Questions are resolved and the mandatory
> security-engineer review (Decision 4) has PASSED with conditional sign-off. Per @svensson00's
> decisions on Eyevinn/open-live#291:
> - **OQ1 → (a):** ship **B + D** conceptually, but see OQ2 — v1 scope is narrowed below.
> - **OQ2 → CONFIRMED-NO:** Strom builds stock, unpatched upstream `centricular/gstcefsrc`
>   (`docker/gstcefsrc/Dockerfile`, SHA `b633408`), which exposes **neither** a per-navigation
>   request-header property **nor** an isolated persistable per-source user-data dir (only the
>   deprecated *global* `cef-cache-location`; PR #671 is per-*instance*, not per-source). Design B's
>   header path and Design C's profile isolation therefore need an upstream gstcefsrc change first.
> - **OQ2-induced scope decision → (b):** **v1 ships Design D (token-in-URL) only.** Designs B and C
>   are deferred together as an **upstream-gated fast-follow** (they unblock once gstcefsrc gains a
>   per-element request header + per-source request-context/user-data-dir).
> - **OQ3 → dedicated `HTML_AUTH_KEY`** (fallback `SRT_PASSPHRASE_KEY`, fail-closed in prod).
> - **OQ4 → passive `expired` status** for v1; active probing is a later enhancement.
> - **OQ5 → Design A (live cookie-forwarding) rejected outright**, not deferred.

## Context

Open Live renders an HTML source (`streamType: 'html'`) by pointing a **shared, server-side
Chromium** (`cefsrc` inside the Strom / GStreamer pipeline) at the source's `address`
(`src/lib/flow-generator.ts:538-545`; `docs/graphics.md`). This works for public pages but not for a
page behind a login (a private dashboard, a scoreboard/stats portal, an MFA-gated provider): the
`cefsrc` navigates as an anonymous, cookie-less context and renders the login wall.

Eyevinn/open-live-studio#129 asks to fix this and proposes doing so by having the operator log in via
a Studio popup and **forwarding the resulting live session cookies** into the shared server-side
browser. @svensson00 (2026-09-16) confirmed the underlying need is real and distinct from the
event-forwarding surface (ADR-002 / #268), but directed that the disposition be decided by a spec and
that the session-handling flow get a `security-engineer` review — "live session cookies into a shared
server-side browser is the sensitive part."

Constraints:
- The renderer is `cefsrc` inside Strom on a GPU host — **not** a browser the operator can see, and
  **not** `strom-html-renderer`/Puppeteer (which do not exist; verified 2026-09-16).
- There is **no** running-element property PATCH in the Strom client (`elements` is `list/get/pads`
  only, `src/lib/strom.ts:805-809`) — the same gap ADR-002 flagged. Credential material must
  therefore be present at **flow-generation time**, before `flows.start`.
- Open Live already has a house pattern for a source secret at rest: SRT passphrase AES-256-GCM
  encryption under an env key, `encv1:` wire prefix, fail-closed in production, never-log the
  plaintext (`src/lib/srt-passphrase-crypto.ts`), plus the ADR-001 "scoped, rotatable, shown/accepted
  once, hash/ciphertext at rest, masked on read" credential posture.

The design choice this ADR settles: **which credential/session mechanism** authenticated HTML sources
use. Full evaluation of all four candidates is in `docs/specs/authenticated-html-sources.md`.

## Decision

1. **Scoped per-source credentials are the primary mechanism, not live cookie-forwarding.**
   Authenticated HTML sources use a **decision ladder**:
   - **token-in-URL** where the provider supports signed/expiring/share links (works today, no new
     code);
   - **a per-source stored credential** (a static auth header / service or refresh token) applied
     server-side by the renderer, as the default new mechanism;
   - **a persisted, isolated per-source renderer profile** as a companion for interactive-login-only
     providers — **gated** (see below);
   - **live cookie-forwarding (the #129 proposal) is rejected** as the primary mechanism.

2. **Any stored secret is encrypted at rest by reusing the `srt-passphrase-crypto` pattern**
   (AES-256-GCM, `encv1:` prefix, fail-closed in production), is **write-only over the API** (accepted
   on write, never returned; masked on read like the SRT passphrase and the ADR-001 gateway token),
   and is **never logged**. A dedicated `HTML_AUTH_KEY` (falling back to `SRT_PASSPHRASE_KEY`) is the
   recommended key, subject to Open Question 3 in the spec.

3. **Credential material is applied at flow-generation time**, inside an **isolated per-source
   Chromium profile** (own user-data dir / cookie jar) so no source's credentials bleed into another
   in the shared browser. There is no attempt to inject credentials into a running `cefsrc` (no such
   primitive exists — `src/lib/strom.ts:805-809`).

4. **A `security-engineer` review of the chosen session-handling flow is a hard gate before any
   Phase 2 implementation.** This ADR and the spec may not proceed to implementation sub-issues until
   that review has signed off on the credential-at-rest handling, the per-source profile isolation,
   and (if pursued) the Design-C interactive-provisioning channel.
   **Status: SATISFIED (2026-09-17).** The security-engineer reviewed the B+D session-handling flow
   and returned **PASS — conditional sign-off** (no design-level blocker). Every finding is an
   implementation condition carried into Phase 2, and @svensson00 confirmed it need not re-run for
   acceptance. The Phase 2 conditions (must all be met when B/D are implemented):
   - Fresh random 12-byte GCM nonce per encrypt; **source-id as GCM AAD** to bind ciphertext to its
     source.
   - Fail-closed SSRF re-check (`graphicUrl()`) at flow-generation; no credentialed navigation on
     validation failure; **do not attach the auth header across cross-origin redirects**.
   - `409`-in-active-production guard covers `rotate`/clear, not just `PATCH`; RBAC + IDOR scoping on
     `:id` for set and rotate.
   - Fail-closed when a stored secret **exists but cannot be decrypted** (wrong/rotated key), never
     fall through to plaintext/empty.
   - Log-redaction for `auth.header.value`, decrypted plaintext, and the full `address`, plus a
     **canary-secret log-scan test** in the acceptance suite.
   - Design-D token-in-URL documented as an explicit operator trade-off: **short-TTL + revocable, not
     equivalent to B**; token-bearing `address` redacted everywhere.
   - Per-source profile dir destroyed/cleaned on source deletion and on credential rotation (applies
     when Design C returns).
   - **If Design C returns:** re-review as a separate gate (persisted login profiles hold full live
     session material — higher blast radius) before the `501` is lifted.

## Consequences

**Positive**:
- Least privilege / smaller blast radius: a scoped, rotatable service token or a deliberately
  provisioned isolated profile is far narrower than a live human session cookie for the operator's
  whole account — directly the ADR-001 posture.
- Reuses existing, already-hardened machinery: the `srt-passphrase-crypto` at-rest pattern, the
  masked-on-read/ shown-once secret handling, and the unchanged `graphicUrl()` SSRF gate.
- Purely additive data model (`SourceDoc.auth?`); existing HTML sources are unchanged; no migration.
- Needs **no** new "inject into a running element" Strom primitive for the default path — material is
  baked in at flow-generation time.

**Negative**:
- Does not, by itself, cover providers that only offer interactive MFA login with no token — that is
  Design C, which is gated on an unresolved provisioning-channel question (spec Open Question 1) and
  may be declared out of scope for v1.
- Introduces another encrypted-secret type and (optionally) another env key to provision.

**Risks**:
- **Credential exfiltration** if the shared server-side host is compromised. *Detection/mitigation:*
  encryption at rest, write-only/masked API, per-source profile isolation, scoped/rotatable creds,
  and the mandatory security review — the reason for the Decision-4 gate.
- **`cefsrc` capability gap — CONFIRMED (2026-09-17).** Strom's stock upstream `cefsrc` can set
  **neither** a top-level-navigation request header **nor** an isolated persistable per-source
  user-data dir (spec Open Question 2, resolved CONFIRMED-NO). A coordinated upstream gstcefsrc change
  is therefore required before Designs B and C can ship — like ADR-002's element-PATCH gap. This is why
  **v1 is scoped to Design D only** and B/C are the upstream-gated fast-follow.
- **Session expiry on air** — a token/profile expiring mid-show drops to the login wall in PGM;
  tracked as spec Open Question 4.

## Alternatives Considered

- **Live cookie-forwarding into the shared server-side browser (the #129 proposal).** *Rejected as
  primary.* Highest blast radius (a live human session for the whole provider account placed in a
  shared, long-lived, egressing browser); `HttpOnly`/`Secure` cookies cannot be reliably harvested
  from a popup via `postMessage` (the sketch assumes readable cookies); no live-inject primitive
  exists (`src/lib/strom.ts:805-809`); and human sessions expire mid-show with no refresh path. Its
  one good idea — session isolation — is preserved by Design C's *deliberately provisioned, isolated,
  persisted profile* instead.
- **Token-in-URL only.** *Adopted as the first rung, but insufficient alone* — only some providers
  offer it, and the token then lives in the URL/`address` (encrypted at rest, but potentially in
  provider logs). Good as the "try this first" path; falls back to stored credentials.
- **A full secret vault / IdP-SSO integration.** *Rejected for this epic* — an org-wide credential
  manager is its own large effort; per-source credentials solve #129's need without it. Not
  precluded later.
- **Reuse the shared `API_KEY` as the source credential.** *Rejected* — it is Open Live's own auth,
  not the *provider's*; reproduces the over-broad-shared-credential failure mode ADR-001 exists to
  avoid.
