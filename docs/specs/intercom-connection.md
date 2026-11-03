# Spec: Intercom connection as a runtime setting

- Issue: [Eyevinn/open-live#617](https://github.com/Eyevinn/open-live/issues/617) — "OL-47: Intercom connection as a runtime setting in open-live (backend)"
- Studio companion: [Eyevinn/open-live-studio#254](https://github.com/Eyevinn/open-live-studio/issues/254) (OL-48) — consumes the contract in §2.
- Status: Implemented (backend)
- Related: ADR-013 (this feature's decisions), ADR-009 (storage connections — the precedent), ADR-012 (guest talkback proxy), `docs/specs/guest-talkback.md`.

## 1. Problem

Guest talkback needs an Open Intercom manager connection. Before #617 it came only from env
(`INTERCOM_MANAGER_URL`, `INTERCOM_MANAGER_TOKEN`, `INTERCOM_MANAGER_AUTH_MODE`,
`INTERCOM_WHIP_AUTH_KEY`). An OSC-hosted instance cannot set those (the OSC service has no options
for them and `supportsUpdate:false`), so talkback could not be turned on there.

Now the operator sets the connection inside Open Live. On OSC the only input is the manager URL;
self-hosted adds the manager API key (and optionally the WHIP key). It applies without a restart.
The env vars stay as the fallback.

## 2. API contract

All routes sit behind the shared `API_KEY` gate (same as `/api/v1/storage-connections`). A missing
or wrong key is a `401`. A DB failure is a `503 { error: "Database unavailable" }`. No response
ever contains a secret value.

### 2.1 `GET /api/v1/intercom-connection` — status

`200`:

```json
{
  "source": "stored",
  "configured": true,
  "url": "https://acme.eyevinn-intercom-manager.auto.prod.osaas.io/api/v1",
  "mode": "osc",
  "modeOverridden": false,
  "tokenSet": false,
  "whipKeySet": false,
  "patSource": "OscAccessToken",
  "oscPatSet": true,
  "problem": null,
  "updatedAt": "2026-11-03T10:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `source` | `stored` \| `env` \| `none` — which configuration is in effect (§3). |
| `configured` | `true` when talkback can use the connection (URL and credential present). |
| `url` | Normalised manager base URL (ends in `/api/v1`), or `null`. Not secret. |
| `mode` | `osc` \| `direct`, or `null`. |
| `modeOverridden` | `true` when the stored mode was set explicitly instead of inferred. |
| `tokenSet` | `direct`: a manager API key is set (stored) / `INTERCOM_MANAGER_TOKEN` is set (env). |
| `whipKeySet` | A WHIP/WHEP key is set. |
| `patSource` | `osc` mode only: `OscAccessToken` (stored connection — the instance's `config.oscPat`) or `INTERCOM_MANAGER_TOKEN` (env fallback). `null` in `direct`. |
| `oscPatSet` | Whether the instance OSC PAT (`OscAccessToken` / `OSC_PAT`) is present. |
| `problem` | Plain-language reason the connection is not usable, else `null` (e.g. *"osc mode needs the instance OSC access token (OscAccessToken / OSC_PAT), which is not set on this instance"*). |
| `updatedAt` | Stored connection only, else `null`. |

### 2.2 `PUT /api/v1/intercom-connection` — set / replace

Body:

```json
{ "url": "https://acme.eyevinn-intercom-manager.auto.prod.osaas.io" }
```

```json
{ "url": "https://intercom.example.com", "apiKey": "<manager API_KEY>", "whipKey": "<manager WHIP_AUTH_KEY>" }
```

| Field | Rules |
|---|---|
| `url` | Required. http(s), no credentials / query / fragment. With or without `/api/v1`; normalised (§5). SSRF-gated (§6). |
| `mode` | Optional advanced override, `osc` \| `direct`. Default: inferred from the host (§5). `osc` is only accepted for an OSC host (`*.osaas.io`) over https. |
| `apiKey` | `direct` only; required unless a key is already stored for the **same manager origin** (then omitted = keep it). Refused in `osc` mode. |
| `whipKey` | `direct` only, optional. Omitted = keep the stored one (same origin only); `null` = clear. Refused in `osc` mode. |

A stored secret is never carried over to a different manager origin: changing the URL to another
host requires entering the key again, so a stored key is never sent to a host it was not entered for.

Responses: `200` with the §2.1 status view; `400 { error }` for an invalid URL, SSRF refusal,
wrong inputs for the mode, or a missing API key; `409` on a concurrent write.

### 2.3 `DELETE /api/v1/intercom-connection` — clear

`204`, idempotent. The env vars (if set) apply again; otherwise talkback is off.

### 2.4 `POST /api/v1/intercom-connection/test` — test

Body (optional): unsaved form values `{ "url": "...", "apiKey"?: "...", "whipKey"?: "...", "mode"?: "osc"|"direct" }`.
Unsaved values are validated like §2.2, never persisted and never logged. In `direct` mode an
omitted `apiKey` / `whipKey` falls back to the stored one only for the same manager origin.
With an empty body the connection in effect (stored, else env) is tested.

`200` (always, for a probe that ran):

```json
{
  "ok": true,
  "status": "ok",
  "message": "Connected: the intercom manager accepted the OSC service access token",
  "httpStatus": 404,
  "mode": "osc",
  "patSource": "OscAccessToken",
  "url": "https://acme.eyevinn-intercom-manager.auto.prod.osaas.io/api/v1",
  "whipKey": "not-used",
  "source": "unsaved"
}
```

| `status` | When |
|---|---|
| `ok` | The manager answered as an authenticated intercom-manager. |
| `unreachable` | DNS / connection error / 10 s timeout. |
| `auth-failed` | The manager (or OSC gateway) answered `401`/`403` — wrong API key (`direct`) or SAT refused (`osc`). `httpStatus` set. |
| `sat-exchange-failed` | `osc`: the OSC token service refused the PAT→SAT exchange (`httpStatus` = its status) or could not be reached. |
| `missing-credential` | No API key (`direct`) or no `oscPat` (`osc`); no network call made. |
| `unexpected-response` | A redirect (never followed), or a status/body that is not an intercom-manager API (wrong URL). |
| `not-configured` | Empty body and no connection in effect (`source: "none"`). |

`source` is `unsaved` \| `stored` \| `env` \| `none`. `whipKey` is `not-verifiable` when a WHIP key is
set (it cannot be checked without a live line), `not-set` when none is (`direct`), `not-used` in
`osc` mode. `400` for invalid unsaved values (same messages as §2.2).

**Probe.** `PATCH {url}/production/999999999999999999999999999999` with body
`{"name":"open-live-connection-test"}`, `Authorization: Bearer <api key | SAT>`,
`redirect: 'manual'`. The manager's API-key guard (`preHandler: requireApiKey`) runs before the
handler and answers `401` on a wrong key (the OSC gateway answers `401`/`403` on a bad SAT); an
authenticated call reaches the handler, which answers `404 { message: "Production with id … not found" }`
and changes nothing (no production can have that id). `GET /productionlist` is **not** used — on
manager 4.1.0 it answered `500 "name is required"` even with a valid SAT (#598) — and the manager's
GET routes are not API-key guarded, so they cannot tell a wrong key from a right one.

## 3. Resolution order

`resolveIntercomConnection()` (`src/lib/intercom-connection.ts`) is the one place the
`config.intercom*` values are read:

1. the stored connection (CouchDB doc `intercom-connection`), when present;
2. else the env vars — exactly today's behaviour (enabled iff `INTERCOM_MANAGER_URL` and
   `INTERCOM_MANAGER_TOKEN` are set; `INTERCOM_MANAGER_AUTH_MODE`; `INTERCOM_WHIP_AUTH_KEY`);
3. else none — talkback disabled.

Every provisioning, talkback proxy call, teardown and status read resolves again; nothing is
cached for the process lifetime. A DB read failure in the resolver falls back to env (today's
behaviour); §5's origin check keeps that from addressing an id on the wrong manager.

Not changed: guests who joined before a connection was added get a talkback line only on rejoin
(lines are created at join).

## 4. Data model

```ts
interface IntercomConnectionDoc {
  _id: 'intercom-connection';      // singleton
  type: 'intercom-connection';
  url: string;                      // normalised, ends in /api/v1
  mode: 'osc' | 'direct';
  modeOverridden: boolean;
  tokenEnc?: string;                // direct: manager API key, "encv1:…"
  whipKeyEnc?: string;              // direct: WHIP key, "encv1:…"
  createdAt: string;
  updatedAt: string;
}
```

`ProductionDoc.intercomManagerOrigin?: string` — origin of the manager `intercomProductionId` was
created on (§5). Set and cleared with `intercomProductionId`.

`GuestSessionDoc.intercomLineProductionId?: string` — the grouping the session's `intercomLineId`
belongs to (§5). Set with `intercomLineId`.

Secrets use the shared credential-encryption key family (ADR-009 D1, ADR-013 D2).

## 5. Auth mode, normalisation, repointing

- **Normalisation:** trailing slashes stripped; `/api/v1` appended when the path does not already end
  with it. `https://x.osaas.io` and `https://x.osaas.io/api/v1/` both give `https://x.osaas.io/api/v1`.
- **Mode inference:** host `osaas.io` or `*.osaas.io` → `osc`; anything else → `direct`.
  - `osc` (stored): the instance's own PAT, `config.oscPat` (`OSC_PAT`, else `OSC_ACCESS_TOKEN` = the
    `OscAccessToken` option), is exchanged for an `eyevinn-intercom-manager` SAT. Never the Strom
    token. If `oscPat` is unset the status says so and talkback stays off. The SAT is also the
    WHIP/WHEP Bearer; no WHIP key.
  - `direct`: the manager API key is the Bearer for management calls; the WHIP key (optional) is the
    Bearer for the WHIP/WHEP proxy.
- **Repointing:** provisioning reuses `intercomProductionId` only when `intercomManagerOrigin`
  matches the connection in effect, else creates a new grouping on the current manager and records
  it. The talkback proxy and guest teardown answer `404 Talkback unavailable` / skip instead of
  addressing an id on another manager, including a guest whose line belongs to an older grouping
  (`intercomLineProductionId`); that guest gets a new line by rejoining. Deactivate only calls the manager the id was created on; if that manager is no longer
  configured (repointed or cleared) it logs `intercom teardown skipped` and completes. A doc without
  `intercomManagerOrigin` predates #617, so its id belongs to the env manager.

## 6. Security

- **SSRF:** a stored or unsaved manager URL whose host is a private/loopback/link-local IP literal
  (or `localhost` / a metadata hostname) is refused with a message naming `TRUSTED_INTERCOM_HOSTS`,
  unless the address matches that allowlist (IP literals / CIDRs, same parsing and `isTrustedHost`
  matcher as `TRUSTED_STORAGE_HOSTS`). The env URL is operator config and not gated.
- **Redirects:** every call that carries a Bearer (management `request()`, the talkback proxy, the
  test probe) uses `redirect: 'manual'`; a `3xx` is an error and is never followed.
- **Secrets:** write-only; stored as `encv1:` ciphertext; responses carry only `tokenSet` /
  `whipKeySet`. Log redaction covers `tokenEnc`, `whipKeyEnc`, `whipKey`, `apiKey`, `credential`
  (`src/lib/log-redact.ts` patterns and `src/server.ts` redact paths); manager error text is
  scrubbed of the key / PAT before it is logged or returned.

## 7. Acceptance criteria → tests

| AC | Test |
|---|---|
| 1 (test unsaved OSC URL → OK, `osc`; set URL with/without `/api/v1`; PAT source `OscAccessToken`) | `intercom-connection-routes.test.ts` |
| 2, 4 (no restart; stored overrides env; clear falls back) | `intercom-connection-runtime.test.ts`, `intercom-connection-routes.test.ts` |
| 3 (cleared → join without `intercomLine`, status not configured) | `intercom-connection-runtime.test.ts` |
| 5 (no secret in responses or logs) | `intercom-connection-routes.test.ts` (`afterAll` scan), `log-redact.test.ts` |
| 6 (repointing) | `intercom-connection-runtime.test.ts` |
| 6b (`source` in all four cases) | `intercom-connection.test.ts`, `intercom-connection-routes.test.ts` |
| 7 (unreachable / wrong key / SAT failure / OK) | `intercom-connection-routes.test.ts` |
| 8 (private address refused naming the allowlist) | `intercom-connection.test.ts`, `intercom-connection-routes.test.ts` |
| 9 (resolver, normalisation, mode inference, redaction) | `intercom-connection.test.ts`, `log-redact.test.ts` |

ACs 1–2 against a real SAT-gated manager are checked on the `olivedev` beta instance.
