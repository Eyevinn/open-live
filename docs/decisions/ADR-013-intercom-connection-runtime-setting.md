# ADR-013: The intercom connection is a stored singleton runtime setting, with env as the fallback

**Date**: 2026-11-03
**Status**: Accepted

> Implements Eyevinn/open-live#617 (OL-47). Full contract in `docs/specs/intercom-connection.md`.
> The choices the issue left open were settled in the architect's triage comment on #617.

## Context

Guest talkback (ADR-012) reaches an Open Intercom manager configured only by env
(`INTERCOM_MANAGER_URL`, `INTERCOM_MANAGER_TOKEN`, `INTERCOM_MANAGER_AUTH_MODE`,
`INTERCOM_WHIP_AUTH_KEY`). OSC-hosted instances cannot set those, so talkback could not be enabled
there. Storage connections (ADR-009) already solved the same problem for object storage.

## Decisions

**D1 — One stored singleton, then env, then none.** The connection is one CouchDB document
(`_id: "intercom-connection"`) managed through `GET|PUT|DELETE /api/v1/intercom-connection` and
`POST /api/v1/intercom-connection/test`, behind the shared `API_KEY` gate. One manager per instance,
so no list. A single resolver (`resolveIntercomConnection()`) returns stored, else env, else none,
and is called on every use, so changes apply without a restart. Env-only deployments behave exactly
as before.

**D2 — Secrets use the shared credential-encryption key family (ADR-009 D1).** The manager API
key and WHIP key are stored as `encv1:` AES-256-GCM ciphertext with the `SRT_PASSPHRASE_KEY` key
source, which falls back to the backend-generated stored key on OSC. No new key family and no new
key env var. Secrets are write-only (`tokenSet` / `whipKeySet` only) and redacted in logs.

**D3 — SSRF: a dedicated `TRUSTED_INTERCOM_HOSTS` allowlist, checked with the existing matcher.**
open-live sends a Bearer to an operator-supplied URL. Private/loopback/link-local IP literals and
`localhost` are refused unless allowlisted; the check reuses `isPrivateHost` / `isTrustedHost`
(`src/lib/url-validation.ts`), the one audited SSRF matcher. Every Bearer-carrying call uses
`redirect: 'manual'`.

**D4 — OSC auth uses the instance's own PAT, and only towards OSC hosts.** Mode is inferred from
the host (`*.osaas.io` → `osc`). `osc` exchanges `config.oscPat` (the `OscAccessToken` option) for
an `eyevinn-intercom-manager` SAT — never the Strom token, whose tenant may differ on a shared
Strom. If `oscPat` is missing, the status says so (no fallback). An explicit `osc` override is
refused for a non-OSC host, so a SAT minted from the instance PAT is never sent elsewhere. A stored
API/WHIP key is only carried over when the manager origin is unchanged.

**D5 — Repointing safety via a recorded manager origin.** `ProductionDoc.intercomManagerOrigin`
records which manager `intercomProductionId` belongs to. Ids are only reused, proxied to or torn
down on that manager; otherwise provisioning creates a new grouping and deactivate skips the
teardown with a log. Docs written before this ADR are treated as belonging to the env manager.

**D6 — The test probe creates no state.** `PATCH /production/<id no manager can hold>` passes the
manager's API-key guard (or the OSC gateway) before the handler, so `401`/`403` means a bad
credential and `404 { message }` means authenticated. `GET /productionlist` is avoided (500s on
manager 4.1.0, #598). The WHIP key is reported as not verifiable.

## Consequences

- Studio (open-live-studio#254) can build the settings UI against `docs/specs/intercom-connection.md`.
- Each intercom use costs one CouchDB read of the singleton document.
- Repointing orphans the old manager's grouping (it is not torn down on the new manager by design);
  the old manager's reaper is responsible for it.
- A guest session records the grouping its line belongs to (`GuestSessionDoc.intercomLineProductionId`), so after repointing an older session's line is never proxied to the new manager; that guest gets a line on the new manager by rejoining.

## Alternatives considered

- Add the four variables to the OSC service options — OSC-platform work, keeps `supportsUpdate:false`
  (every change recreates the instance), does nothing for self-hosted. Rejected by the product
  decision on 2026-11-03.
- Reuse `TRUSTED_STORAGE_HOSTS` — couples two unrelated trust decisions. Rejected (D3).
- A dedicated intercom key family — more key surface on OSC for a credential in the same trust
  tier as storage secrets. Rejected (D2).
