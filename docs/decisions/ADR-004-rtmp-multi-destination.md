# ADR-004: RTMP multi-destination models each destination as an `OutputDoc`, with the stream key handled as an encrypted, write-only credential

**Date**: 2026-09-18
**Status**: Proposed

## Context

Open Live has no way to publish a production to YouTube Live, Twitch, or Facebook. The `OutputType`
union is closed to exactly `'mpegtssrt' | 'efpsrt' | 'whep' | 'recording'` (`src/db/types.ts:187`,
confirmed live 2026-09-18) — no RTMP member, no destination/credential model, no per-platform preset.
Eyevinn/open-live#319 (OL-11) asks for an "easy publishing" experience: pick a platform, paste a
stream key, done — streaming to multiple destinations simultaneously. Eyevinn/open-live-studio#143 is
the Studio-side companion for the destination-management UI. The full design is in
`docs/specs/rtmp-multi-destination.md`.

Constraints:
- **Strom already ships the engine primitive.** `builtin.rtmp_output` merged in strom PR#827,
  released v0.6.9 (2026-09-16); `rtmp2sink` reportedly accepts YouTube/Twitch RTMP(S) URL shapes
  (strom docs PR#776), though no end-to-end publish to a real platform has been proven (Tier 1 in the
  epic).
- **Two upstream Strom bugs are load-bearing and OPEN** (confirmed 2026-09-18, not duplicated here):
  strom#783 (`rtmp_output` default video profile not constrained to what RTMP receivers accept) and
  strom#840 (a refused input leaves the identity src pad unlinked → `Internal data stream error`
  instead of a clean per-destination rejection).
- **Open Live has a hardened house pattern for an output secret at rest**: SRT passphrases are
  encrypted AES-256-GCM under `SRT_PASSPHRASE_KEY`, with an `encv1:` wire prefix, fail-closed in
  production, and a never-log-the-plaintext rule (`src/lib/srt-passphrase-crypto.ts:1-33, 117-157`);
  the outputs route already masks the secret on read (`src/routes/outputs.ts:76-79, 88`). ADR-001
  established the "scoped, accepted-on-write, ciphertext/hash at rest, masked on read" credential
  posture; ADR-003 reused `srt-passphrase-crypto` for HTML-source auth material.
- **Outputs are already a list on a production.** `ProductionDoc.outputAssignments?` is an array of
  `{ outputId }` (`src/db/types.ts:220-222, 389`), and the flow generator already fans out one Strom
  block per assigned output (`src/lib/flow-generator.ts:854, 920-934`).
- **Credential-exposure precedents.** open-live PR#316 (merged) redacts token-bearing addresses from
  logs — and strom PR#827's own body notes the flow-create handler logs the whole request body at
  `debug`. open-live-studio#10 (closed, HIGH / CVSS 7.5) was a credential exposed in plaintext to the
  browser via a public static asset — the pattern a v1 stream-key UI must never repeat.

The design choices this ADR settles: **how RTMP multi-destination is modelled** and **how the stream
key is handled as a credential**.

## Decision

1. **Each RTMP destination is modelled as its own `OutputDoc` with a new `outputType: 'rtmp'`**, not a
   new collection or a nested destination array. Multiple simultaneous destinations per production are
   expressed through the existing `ProductionDoc.outputAssignments[]` mechanism, and the flow
   generator's existing per-output loop fans out one `builtin.rtmp_output` block per assigned
   destination, wired from the program feed pad and main audio bus exactly like the SRT output. This
   reuses, for free, the delete-guard (`409` in active production), the derived `OutputStatus`, the
   masking on read, and the assignment UX that already exist.

2. **A single `'rtmp'` `OutputType` member covers both RTMP and RTMPS**; the scheme is carried in the
   resolved ingest URL (presets use `rtmps://` where required), mirroring how `'mpegtssrt'`/`'efpsrt'`
   share one output block. Platform presets (YouTube/Twitch/Facebook) are a static, secret-free
   server-side ingest-URL table; the operator supplies only a stream key. (Which presets ship in v1 —
   including whether a `'custom'` raw-URL preset ships — is spec Open Question 1, a product decision.)

3. **The stream key is handled as an encrypted, write-only credential, never composed into a stored
   URL.** It is:
   - **encrypted at rest by reusing `src/lib/srt-passphrase-crypto.ts`** (AES-256-GCM, `encv1:`
     prefix, fail-closed in production) into a `rtmp.streamKeyEnc` field — never stored plaintext;
   - **write-only over the API** (accepted on create/patch, never returned; the API echoes only
     `streamKeySet: boolean`, mirroring ADR-003's `valueSet`), and **never** placed in the `OutputDoc.url`
     or the derived `connect` field;
   - **never logged in plaintext** — this covers both open-live's own logging of the generated flow
     (redact `rtmp_url`, per open-live PR#316's discipline) and the fact that Strom's flow-create
     handler logs the request body at `debug` (strom PR#827): open-live must never hand a composed-key
     URL to a Strom instance that logs it unredacted;
   - **never shipped to the browser unmasked** (the Studio companion #143 owns the UI side; masked
     input, no plaintext round-trip — explicitly not the open-live-studio#10 failure).
   The key is decrypted and composed into `rtmp_url` **only at flow-generation time**, inside the flow
   generator, before `flows.start` — there is no running-element PATCH primitive (the ADR-002/ADR-003
   gap), so a destination add/rotate needs a flow restart, not a hot update.

4. **The credential-at-rest key choice is a security decision (spec Open Question 2).** The
   recommendation is a dedicated `RTMP_STREAM_KEY_KEY` that falls back to `SRT_PASSPHRASE_KEY` when
   unset (blast-radius isolation, matching ADR-003's `HTML_AUTH_KEY` choice), fail-closed in
   production. A `security-engineer` review of the stream-key handling flow is a **hard gate before
   any Phase 2 implementation**, and so is the closure of the two load-bearing upstream deps (strom#783,
   strom#840) — implementation may not begin while "easy publishing" would silently fail on the first
   destination that refuses a codec.

## Consequences

**Positive**:
- Minimal, additive data model: one new `OutputType` member + an optional `rtmp?` object; no CouchDB
  migration; existing outputs/productions unchanged.
- Reuses already-hardened machinery: the `srt-passphrase-crypto` at-rest pattern, the masked-on-read
  secret handling, the `409`-in-active-production delete guard, the per-output flow fan-out, and the
  existing production-assignment UX — so "multiple simultaneous destinations" needs no new
  orchestration code.
- Least-privilege credential posture (ADR-001): the key is scoped, write-only, encrypted, and never
  leaves the server in plaintext.

**Negative**:
- Modelling each destination as a separate `OutputDoc` means an operator managing many destinations
  creates/deletes several outputs; there is no single "destination group" document (acceptable for
  v1 — the assignment list already groups them per production).
- Adds another encrypted-secret type and (optionally) another env key to provision.
- No hot add/rotate of a destination on a live production — a flow restart is required (the
  no-live-inject constraint), so mid-show destination changes are a limitation, not a feature.

**Risks**:
- **Stream-key exfiltration** if the shared server-side host is compromised, or via a logging path
  (open-live flow logs, or Strom's debug body log). *Detection/mitigation:* encryption at rest,
  write-only/masked API, the `rtmp_url` log-redaction hard rule, and the mandatory security review —
  the reason for the Decision-4 gate.
- **Upstream Strom gap — OPEN.** strom#783 (encoder profile) and strom#840 (per-destination rejection)
  gate a genuinely easy experience; per-destination status cannot be surfaced truthfully until
  strom#840 closes (today's `OutputStatus` is flow-level only — issue #255), and "no operator tuning"
  depends on strom#783. Implementation is blocked on both (epic kill-condition 2026-10-16).
- **Unproven end-to-end.** No real platform publish has been demonstrated; the preset URL table and
  encoder defaults must be verified live before this is considered done.

## Alternatives Considered

- **A nested `destinations[]` array on a single RTMP `OutputDoc` (or on the production).** *Rejected.*
  It would duplicate the fan-out, delete-guard, status-derivation, and masking logic the per-output
  model already gets for free, and it fights the existing `outputAssignments[]` grouping. The
  one-output-per-destination model is strictly less new code.
- **Compose the stream key into `OutputDoc.url` and reuse the SRT passphrase masking as-is.**
  *Rejected.* Smearing the key into a free-text URL invites it into the derived `connect` field
  (`outputs.ts:95-101`) and into logs; a structured, stripped-on-read `rtmp.streamKeyEnc` keeps the
  key out of every URL-shaped surface. Encryption still reuses `srt-passphrase-crypto`, just at the
  field level.
- **A second `OutputType` member for RTMPS.** *Rejected.* The scheme lives in the resolved ingest URL;
  a single `'rtmp'` member matches how `mpegtssrt`/`efpsrt` already share one output block and keeps
  the union minimal.
- **OAuth "sign in with YouTube/Twitch" account integration for v1.** *Rejected — explicitly out of
  scope per epic#319.* A paste-a-stream-key credential solves the v1 need without an OAuth/IdP
  integration, which would be its own epic. Not precluded as a follow-up.
- **Ship the UI now and rely on Strom's current `rtmp_output` as-is.** *Rejected.* With strom#783 and
  strom#840 open, the first destination that refuses a codec produces an `Internal data stream error`
  rather than a clean per-destination failure — "easy publishing" would become a support burden. The
  ADR gates implementation on those closing.
