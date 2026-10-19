# Spec: Storage connections as a first-class resource

- Issue: [Eyevinn/open-live#520](https://github.com/Eyevinn/open-live/issues/520) — "OL-21: Storage connections as a first-class resource for S3 clip sources and recording targets"
- Status: Draft (architect, Phase 1 — pre-implementation)
- Repos affected: `Eyevinn/open-live` (backend, this spec). A follow-up `open-live-studio` issue (Setup "Storage" tab, pickers, read-only bucket browser) is filed once this REST contract is settled.
- Type: new resource + CRUD surface + listing endpoint; additive changes to the `s3` clip reference, the `recording` output, and `RecordingDoc`.
- Related: ADR-009 (encryption-key source + SSRF/private-endpoint policy).

> Spec for #520.

---

## 1. Problem Statement

Object storage is configured once per instance through environment variables. An `s3` clip
reference stores a bucket and a key; everything else (endpoint, region, credentials) comes
from `MINIO_*` / `S3_ENDPOINT`, and recording uploads use the same credential. Grounded in
current `main`:

- `resolveClipFile` presigns an `s3` reference with `minioTargetFromConfig(ref.bucket)`
  (`src/lib/clip-control.ts:168-182`; the local `presignS3Get` wrapper at
  `src/lib/clip-control.ts:122` delegates to `presignGetUrl`). Only the **bucket** comes from
  the reference (since #505); endpoint/region/credentials come from config.
- `minioTargetFromConfig` reads `MINIO_ENDPOINT`/`S3_ENDPOINT`, `MINIO_ACCESS_KEY`,
  `MINIO_SECRET_KEY`, `MINIO_REGION`, `MINIO_USE_SSL` (`src/lib/recording-uploader.ts:124-152`,
  `src/config.ts:273-278`) and returns a `MinioTarget` (`src/lib/recording-uploader.ts:37-45`).
- Recording upload on deactivate (`src/routes/productions.ts:~1051`, via `uploadRecordings` with
  `minioTargetFromConfig()`) and recording playback presign (`src/routes/recordings.ts:53-64`,
  `buildPresigner` → `presignGetUrl`) use the same function and the same key pair. The
  playback presigner already refuses to sign when a recording's stored bucket differs from the
  configured bucket (`recordings.ts:60`).
- `RecordingDoc` stores a `bucket: string` only — no connection reference
  (`src/db/types.ts:352-367`).

Consequences:

- One object store per instance. A customer's own S3 or a second MinIO cannot be used without
  repointing the whole instance (and a restart).
- One key pair serves both recording (write) and clip reads, so least privilege between them
  cannot be split.
- Operators cannot add or change a storage location from Studio; a wrong bucket, key, or
  credential only surfaces at Cue (clip) or silently drops the `playbackUrl` (recording).

**Proposal.** Add a named `StorageConnection` resource. Clip sources and recording targets each
*optionally* choose a connection. The existing environment configuration stays as an implicit
**default connection**, so current instances, existing `s3` references, and existing
recordings keep working unchanged.

### Goals

1. CRUD for storage connections under `/api/v1/storage-connections`, behind the shared
   `API_KEY` gate (exactly like `/api/v1/gateways`).
2. The secret key is write-only: encrypted at rest with the AES-256-GCM `encv1:` scheme,
   never returned, redacted in logs.
3. Optional `connectionId` on the `s3` clip reference, on the `recording` output, and recorded
   on `RecordingDoc`. Absent = the default connection built from the environment — exactly as
   today.
4. A "test connection" call that reports reachable / auth-failed / bucket-not-found when the
   connection is saved, and states which side ran the check (open-live or Strom).
5. A read-only, capped, credential-free object-listing endpoint for Studio's object picker.
6. Guardrails: `httpUrlOnly`-style endpoint validation by default (with a documented private-
   endpoint escape hatch); a referenced connection cannot be deleted.

### Out of scope (from the issue)

- Upload / delete / rename / tagging / metadata / search / thumbnails through the listing
  (the MAM owns library management). Listing is read-only, only to pick an object.
- The `tams` clip reference type (stays reserved).
- Changing how recordings are laid out in the bucket.

---

## 2. API Design

All routes sit behind the existing shared `API_KEY` bearer `onRequest` gate (`src/server.ts`),
identical to `/api/v1/gateways` and `/api/v1/sources`. A missing/invalid key is rejected by
that gate with `401` before any handler runs; the handlers below assume an authenticated
caller. DB failures return `503 { "error": "Database unavailable", "statusCode": 503 }`,
mirroring `gateways.ts`.

### 2.1 Resource view (what the API returns)

The secret key is **never** in any response. The canonical connection view:

```jsonc
{
  "id": "stconn-7b1c…",
  "name": "Customer West S3",
  "endpoint": "s3.eu-west-1.amazonaws.com",   // host[:port], scheme stripped
  "region": "eu-west-1",
  "useSsl": true,
  "defaultBucket": "acme-clips",              // optional convenience bucket
  "role": "clip",                             // "clip" | "recording" | "both" (advisory, default "both")
  "accessKey": "AKIA…",                       // access key id is NOT a secret and IS returned
  "secretKeySet": true,                       // mirrors ADR-003 valueSet / ADR-004 streamKeySet
  "createdAt": "2026-10-16T10:00:00.000Z",
  "updatedAt": "2026-10-16T10:00:00.000Z"
}
```

`role` is an advisory tag used by Studio/docs to steer least-privilege (a clip connection
wants a read+list key, a recording connection a write key); it is **not** enforced by the
backend in v1 (enforcement is a follow-up — see §7).

### 2.2 `POST /api/v1/storage-connections` — create

Request:

```jsonc
{
  "name": "Customer West S3",
  "endpoint": "https://s3.eu-west-1.amazonaws.com",  // host[:port] or full URL; scheme sets useSsl when present
  "region": "eu-west-1",                              // optional, default "us-east-1" (matches MINIO_REGION default)
  "useSsl": true,                                     // optional; ignored when endpoint carries a scheme
  "accessKey": "AKIA…",
  "secretKey": "…",                                   // write-only, required on create
  "defaultBucket": "acme-clips",                      // optional
  "role": "clip"                                      // optional, default "both"
}
```

Validation (zod + semantic, mirroring `gateways.ts` / `clip-reference.ts`):

| Field | Rule |
|-------|------|
| `name` | `string`, 1–256 chars |
| `endpoint` | normalised to `host[:port]` + `useSsl` exactly as `minioTargetFromConfig` does (`recording-uploader.ts:138-146`); then validated by the new `storageEndpointHost()` guard (§5) — host must resolve to a non-private IP literal **unless** allow-listed via `TRUSTED_STORAGE_HOSTS` |
| `region` | `string`, ≤ 64, default `us-east-1` |
| `accessKey` | `string`, 1–256 |
| `secretKey` | `string`, 1–1024; encrypted immediately (never persisted plaintext) |
| `defaultBucket` | optional; same bucket-name rule as `assertS3Bucket` (`clip-reference.ts:82-92`) |
| `role` | optional enum `clip`\|`recording`\|`both`, default `both` |

Responses:

- `201` → the resource view (§2.1), `secretKeySet: true`, no secret.
- `400 { error, statusCode: 400 }` → validation failure, including a rejected private/loopback
  endpoint: `"endpoint resolves to a private/loopback/link-local address; add its host or CIDR to TRUSTED_STORAGE_HOSTS to allow it"`.
- `503` → DB unavailable.

### 2.3 `GET /api/v1/storage-connections` — list

- `200` → array of resource views. When the environment default is configured
  (`minioTargetFromConfig()` is non-null), the array includes a **synthetic read-only default
  entry** so Studio pickers can offer it:

```jsonc
{ "id": "default", "name": "Default (instance storage)", "endpoint": "…", "region": "…",
  "useSsl": true, "role": "both", "accessKey": "…", "secretKeySet": true,
  "isDefault": true, "createdAt": null, "updatedAt": null }
```

  `isDefault` connections cannot be updated or deleted (`403`/`409` respectively — see below)
  and have no stored document.

### 2.4 `GET /api/v1/storage-connections/:id` — read one

- `200` → resource view. `id: "default"` returns the synthetic default when env storage is
  configured, else `404`.
- `404 { error: "Storage connection not found", statusCode: 404 }`.

### 2.5 `PATCH /api/v1/storage-connections/:id` — update

Accepts any subset of the create fields. `secretKey` is **optional**: when omitted the stored
ciphertext is preserved (the key is never round-tripped through the client to be re-submitted);
when present it is re-encrypted and replaces the old one. Endpoint re-validated on change.

- `200` → updated resource view.
- `400` → validation / SSRF rejection.
- `403 { error: "The default connection is read-only", statusCode: 403 }` → `id: "default"`.
- `404` → unknown id.
- `503` → DB unavailable.

### 2.6 `DELETE /api/v1/storage-connections/:id` — delete (referential-integrity gated)

Before deleting, the handler checks for references:

- any `SourceDoc` whose deserialized `address` is an `s3` clip reference with this
  `connectionId`;
- any `OutputDoc` of type `recording` with this `connectionId`;
- any `RecordingDoc` with this `connectionId`.

Responses:

- `204` → deleted (no references).
- `409 { error: "Storage connection is referenced by N source(s), M output(s), K recording(s) and cannot be deleted", statusCode: 409, references: { sources: N, outputs: M, recordings: K } }`.
- `403` → `id: "default"` (the default is not a document and cannot be deleted).
- `404` → unknown id.

The delete-guard mirrors the gateway `forget` guard shape (`gateways.ts:95-120`, `409` when
still in use).

### 2.7 `POST /api/v1/storage-connections/:id/test` — test connection

Runs a credential-exercising probe against the connection and reports a **structured result**
with HTTP `200` (the probe outcome lives in the body, not the status code, so Studio can render
a precise message — a non-reachable store is not an API error).

Request (optional):

```jsonc
{ "bucket": "acme-clips", "from": "open-live" }   // bucket defaults to defaultBucket; from: "open-live" | "strom", default "open-live"
```

Probe: a `HEAD`/`GET` bucket listing (`ListObjectsV2` with `max-keys=1`) SigV4-signed with the
decrypted credentials, classifying the HTTP result with the **existing** S3 error-code detector
(`detectS3AuthError`, `recording-uploader.ts:105-114`, which already recognises
`InvalidAccessKeyId` / `AccessDenied` / `SignatureDoesNotMatch` and 401/403).

Response `200`:

```jsonc
{
  "checkedFrom": "open-live",          // echoes which side ran the probe (issue req. 4)
  "reachable": true,                   // TCP/TLS/DNS reached the endpoint
  "auth": "ok",                        // "ok" | "failed" | "forbidden"
  "bucket": "found",                   // "found" | "not-found" | "unchecked"
  "canList": true,                     // list permission present (for clip connections)
  "message": "Reached endpoint; credentials valid; bucket 'acme-clips' found."
}
```

Failure examples (still HTTP `200`): `{ reachable:false, … , message:"Endpoint unreachable (DNS/connect/TLS)." }`,
`{ reachable:true, auth:"failed", message:"Authentication failed (InvalidAccessKeyId)." }`,
`{ reachable:true, auth:"ok", bucket:"not-found", message:"Bucket 'acme-clips' not found." }`.

`from: "strom"` is accepted but, per Open Question 3 (§7), its availability depends on an
unverified Strom capability; when open-live cannot delegate, it returns `checkedFrom:"open-live"`
with `"note":"Strom-side check unavailable; probed from open-live."` rather than failing.

- `404` → unknown id. `400` → malformed body.

### 2.8 `GET /api/v1/storage-connections/:id/objects` — read-only object listing

For Studio's object picker. One page of folders and objects under a prefix.

Query params: `prefix` (default `""`), `cursor` (opaque — the S3 `ContinuationToken`),
`bucket` (default `defaultBucket`; required if the connection has none).

Implementation: `ListObjectsV2` SigV4-signed with the connection's decrypted credentials,
`delimiter=/`, `max-keys = min(requested, STORAGE_LIST_MAX_KEYS)` (default cap 1000),
`continuation-token = cursor`.

Response `200`:

```jsonc
{
  "bucket": "acme-clips",
  "prefix": "shows/2026/",
  "folders": [ { "prefix": "shows/2026/ep1/" } ],          // CommonPrefixes
  "objects": [ { "key": "shows/2026/intro.mp4", "name": "intro.mp4", "size": 10485760, "lastModified": "2026-10-01T12:00:00.000Z" } ],
  "cursor": "1a2b3c…"                                       // NextContinuationToken, omitted when the last page
}
```

Credentials are **never** in the response. Errors:

- `200` with empty `folders`/`objects` for an empty prefix.
- `403 { error: "The storage key lacks list permission (AccessDenied)", statusCode: 403 }`
  when the key cannot list (distinct from the API auth gate, which already passed).
- `404` → unknown connection id, or bucket not found (`{ error: "Bucket not found", statusCode: 404 }`).
- `502 { error: "Object store unreachable", statusCode: 502 }` → endpoint unreachable.

Rate/size posture: page size capped server-side; no recursion (delimiter-scoped); read-only.

### 2.9 `connectionId` additions to existing contracts

**`s3` clip reference** (`src/lib/clip-reference.ts:50-54`, `clipReferenceS3Schema`): add an
optional `connectionId: z.string().min(1).max(128).optional()`. Shape only; the existing
`assertS3Bucket` / `assertS3Key` semantic checks are unchanged. A reference with a
`connectionId` that no longer resolves is a Cue-time error (same place a bad bucket surfaces
today).

**`recording` output** (`OutputDoc`): add optional `connectionId?: string` to the recording
output's config. Absent = default connection (env) — exactly as today.
*Amended by #534:* the `connectionId` must exist (`400 "Storage connection not found"` on `POST`
and `PATCH`), and a recording output is accepted without `MINIO_*` env when it names a
connection — see `vod-recording-minio.md` §"Connection-only targets, downloads and upload
outcome".

**`RecordingDoc`** (`src/db/types.ts:352-367`): add optional `connectionId?: string`, recording
which connection wrote the asset. Written at upload time from the output's `connectionId` (absent
when the default was used). See §3 for migration.

No new verbs on the sources/outputs/recordings routes — only the optional field flows through
their existing create/patch bodies and zod schemas.

---

## 3. Data Model + Migration

### 3.1 New document type `StorageConnectionDoc`

Stored in its own logical CouchDB collection (`getStorageConnectionsDb()`, same factory pattern
as `getGatewaysDb()`):

```ts
export interface StorageConnectionDoc {
  _id: string;              // "stconn-<uuid>"
  _rev?: string;
  type: 'storage-connection';
  name: string;
  endpoint: string;         // host[:port], scheme stripped (as MinioTarget.endpoint)
  useSsl: boolean;
  region: string;
  accessKey: string;        // access key id — not secret, stored/returned in clear
  secretKeyEnc: string;     // "encv1:<base64url(iv|tag|ciphertext)>" — NEVER plaintext, NEVER returned
  defaultBucket?: string;
  role: 'clip' | 'recording' | 'both';
  createdAt: string;
  updatedAt: string;
}
```

A `StorageConnectionDoc` maps 1:1 onto a `MinioTarget` (`recording-uploader.ts:37-45`) once
`secretKeyEnc` is decrypted and a bucket is supplied, so the existing `presignGetUrl` /
`putObject` / `uploadRecordings` code paths are reused verbatim with a per-connection target
instead of `minioTargetFromConfig()`.

### 3.2 The implicit default connection

The reserved id `"default"` denotes the env-derived connection. It is **not** a document: it is
materialised on demand from `minioTargetFromConfig()`. `resolveStorageTarget(connectionId?, bucket?)`
is the single resolver used by clip, recording-upload, and recording-playback paths:

```
resolveStorageTarget(connectionId?, bucketOverride?):
  if connectionId and connectionId !== "default":
     load StorageConnectionDoc -> decrypt secretKeyEnc -> MinioTarget (bucket = bucketOverride ?? defaultBucket)
  else:
     minioTargetFromConfig(bucketOverride)        // unchanged default behaviour
```

### 3.3 Migration strategy — no backfill

- New collection only; no change to existing documents on upgrade.
- Existing `s3` clip references have no `connectionId` → resolve via the default path
  (`minioTargetFromConfig(ref.bucket)`), byte-for-byte as on `main`.
- Existing `RecordingDoc`s have **no** `connectionId`. **Decision (OQ4, resolved):** absent
  `connectionId` means the default connection, and no backfill runs. This is exactly the data
  the playback presigner already relies on today (`recordings.ts:60` presigns against the
  configured bucket). Playback for old recordings is therefore unchanged. The alternative —
  stamping a synthetic `connectionId: "default"` onto every historic `RecordingDoc` — is a
  write-amplifying migration that buys nothing, since "absent" and `"default"` resolve
  identically. Rejected.
- Rollback: dropping the feature leaves `storage-connection` docs orphaned and the optional
  `connectionId` fields ignored; default-path behaviour is unaffected.

### 3.4 Recording playback with a connection

`buildPresigner` (`recordings.ts:53-64`) gains a per-recording branch: if the `RecordingDoc`
carries a `connectionId`, presign with that connection's target (bucket from the doc); else the
current default-bucket-matched path. Old recordings (absent id) keep working; a recording whose
connection was since deleted falls through to "no `playbackUrl`" exactly as the current
bucket-mismatch branch does — and §2.6's delete-guard makes that case rare by refusing to delete
a referenced connection in the first place.

---

## 4. Service Interactions

Clip cue + recording, showing open-live resolving the target, Strom fetching the presigned URL,
and the object store. open-live always holds the credentials; Strom only ever receives a
short-lived presigned URL.

```mermaid
sequenceDiagram
    autonumber
    participant Studio
    participant OL as open-live
    participant DB as CouchDB
    participant OS as Object store (S3/MinIO)
    participant Strom

    Note over Studio,OS: Setup — create & test a connection
    Studio->>OL: POST /api/v1/storage-connections {name,endpoint,accessKey,secretKey,…}
    OL->>OL: validate endpoint (httpUrlOnly-style + TRUSTED_STORAGE_HOSTS)
    OL->>OL: encrypt secretKey -> encv1: (ADR-009 key)
    OL->>DB: insert StorageConnectionDoc (secretKeyEnc)
    OL-->>Studio: 201 {…, secretKeySet:true}  (no secret)
    Studio->>OL: POST /storage-connections/:id/test {bucket}
    OL->>DB: get doc; decrypt secret
    OL->>OS: ListObjectsV2 max-keys=1 (SigV4)
    OS-->>OL: 200 | 403 | 404 | conn error
    OL-->>Studio: 200 {checkedFrom:"open-live", reachable,auth,bucket,message}

    Note over Studio,OS: Object picker
    Studio->>OL: GET /storage-connections/:id/objects?prefix=&cursor=
    OL->>OS: ListObjectsV2 delimiter=/ (SigV4, capped)
    OS-->>OL: CommonPrefixes + Contents + NextContinuationToken
    OL-->>Studio: 200 {folders,objects,cursor}  (no credentials)

    Note over Studio,Strom: Cue an s3 clip bound to a connection
    Studio->>OL: cue clip (s3 ref {connectionId,bucket,key})
    OL->>DB: resolveStorageTarget(connectionId) -> decrypt secret
    OL->>OL: presignGetUrl(target,key,ttl)  (SigV4 GET URL)
    OL->>OS: preflight ranged GET bytes=0-0 (issue #351)
    OS-->>OL: 206/200 reachable
    OL->>Strom: setPlaylist(presigned GET URL)
    Strom->>OS: GET presigned URL (Strom fetches media)
    OS-->>Strom: media bytes

    Note over OL,OS: Recording upload on deactivate
    OL->>DB: resolveStorageTarget(output.connectionId)
    OL->>OS: putObject(segments) (SigV4, write key)
    OL->>DB: insert RecordingDoc {connectionId,bucket,key}
```

---

## 5. Guardrails: endpoint SSRF validation

The backend signs and sends requests to whatever host an `API_KEY` holder names. Today that host
is fixed (env `MINIO_ENDPOINT`); a storage connection makes it operator-supplied, so the endpoint
needs the same SSRF posture as clip `url` references.

**Decision (OQ2, resolved — see ADR-009):** validate the connection endpoint host with the
existing `isPrivateHost()` machinery (`url-validation.ts:34-60`) and relax it only through a
deployment allowlist `TRUSTED_STORAGE_HOSTS`, modelled byte-for-byte on the already-reviewed
`TRUSTED_SRT_HOSTS` pattern (`docs/specs/configurable-srt-private-host-allowlist.md`, §2–§3) and
the `TRUSTED_HOSTS` config idiom (`config.ts:82-85`). A new pure helper:

```ts
// url-validation.ts, alongside httpUrlOnly / srtUrl
export function storageEndpointHost(endpoint: string, trustedStorageHosts: readonly string[] = []): string
// normalises endpoint -> host[:port]; rejects a private/loopback/link-local host literal
// unless it matches trustedStorageHosts (bare IP or CIDR); returns the host on success.
```

- Default (`TRUSTED_STORAGE_HOSTS` unset / empty): every private/loopback/link-local endpoint is
  rejected — the safe cloud/OSC posture.
- Self-hosted MinIO on a private LAN: operator adds the host/CIDR (e.g.
  `TRUSTED_STORAGE_HOSTS=192.168.1.0/24`).
- **Not** a per-connection boolean (that lets any `API_KEY` holder self-authorise SSRF to the
  cloud metadata endpoint) and **not** a coarse global boolean (re-opens the whole RFC1918 +
  169.254 surface at once). The allowlist is a strict superset of the boolean's safety, and it
  reuses the SRT allowlist's exact matching/CIDR/IPv4-mapped-IPv6 logic so there is one SSRF
  code path to review, not two.

DNS-name endpoints are not resolved synchronously (same limitation as `isPrivateHost` /
`httpUrlOnly` — this blocks the direct-IP-literal vector); a resolving SSRF guard remains a
shared follow-up for both this and `httpUrlOnly`.

---

## 6. Configuration

The env defaults become the implicit **default connection** — no behaviour change when no
connection is created:

| Property | Env var | Role | Default |
|----------|---------|------|---------|
| default endpoint | `MINIO_ENDPOINT` / `S3_ENDPOINT` | default connection endpoint | — |
| default credentials | `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | default connection credentials | — |
| default bucket | `MINIO_BUCKET` | default bucket | — |
| default region | `MINIO_REGION` | default region | `us-east-1` |
| default SSL | `MINIO_USE_SSL` | default scheme | `true` |

New config:

| Property | Env var | Type | Default | Purpose |
|----------|---------|------|---------|---------|
| `storageConnectionKey` | `STORAGE_CONNECTION_KEY` | 32-byte base64/hex | unset → stored credential key (#438) | AES-256 key for `secretKeyEnc` (ADR-009) |
| `trustedStorageHosts` | `TRUSTED_STORAGE_HOSTS` | `string[]` IP/CIDR | `[]` (block all private) | SSRF allowlist for connection endpoints (§5) |
| `storageListMaxKeys` | `STORAGE_LIST_MAX_KEYS` | positive int | `1000` | page-size cap for `/objects` |

`STORAGE_CONNECTION_KEY` follows the `KeySource` abstraction already in
`srt-passphrase-crypto.ts:54-82`: a dedicated env override that, when unset, falls back to the
backend-generated **shared** credential-encryption key (`credential-encryption-key.ts`, #438) —
so OSC instances stay zero-config, and self-hosted deployments can pin/rotate their own key. See
ADR-009 for why this is the shared-stored family (SRT/HTML), not the fully-isolated RTMP family.

No Strom JSON shape change: Strom still receives a plain presigned URL via `setPlaylist`
(clips) and open-live still pulls segments via Strom's media download API before `putObject`
(recording) — the connection only changes which credentials sign those URLs/requests inside
open-live.

---

## 7. Open Questions

Resolved in this spec (team decisions, no human gate needed):

- **OQ1 — encryption-key source.** Resolved: a dedicated `STORAGE_CONNECTION_KEY` env override
  that falls back to the shared backend-generated credential-encryption key (#438) when unset —
  the SRT/HTML shared-stored family via the existing `KeySource` abstraction, **not** an isolated
  per-kind stored key like RTMP's `RTMP_CREDENTIALS_KEY`. Rationale and trade-off in **ADR-009**.
- **OQ2 — private-endpoint policy.** Resolved: `TRUSTED_STORAGE_HOSTS` deployment allowlist
  (host/CIDR), default empty, reusing the reviewed `TRUSTED_SRT_HOSTS` matcher. Not a per-
  connection flag, not a global boolean. §5 + **ADR-009**.
- **OQ4 — old-recording migration.** Resolved: absent `RecordingDoc.connectionId` = default
  connection; no backfill (§3.3). "Absent" and `"default"` resolve identically, so a migration
  buys nothing.

Flagged for a human (genuine unverified cross-service premise — do **not** guess):

- **OQ3 — can the shared OSC Strom reach arbitrary customer endpoints?** *Unverified.* This is a
  networking/security property of the shared OSC Strom egress, owned outside this repo; whether a
  shared Strom may fetch presigned URLs from, or be asked to run a test against, an arbitrary
  customer-named object store is a security posture decision, not a code decision.
  **Recommended default pending confirmation:** treat the answer as **No** — open-live performs
  the **authoritative** test/reachability probe itself (`checkedFrom:"open-live"`), the Strom-side
  check is advisory-only and returns a `note` when unavailable (§2.7), and the presigned-URL fetch
  (which Strom already does today for the default store) is the only Strom→object-store egress we
  rely on. Confirm with whoever owns OSC Strom networking before advertising a Strom-side
  reachability test or relaxing egress. This does not block implementing everything else in the
  spec (the default is safe and matches today's Strom egress).

---

## 8. Risks

- **Secret exfiltration (highest).** A stored object-store credential that can both read clips
  and write recordings is a high-value secret. *Mitigations:* `encv1:` AES-256-GCM at rest,
  write-only API (`secretKeySet` only, never returned — mirroring ADR-003 `valueSet` / ADR-004
  `streamKeySet`), log redaction via the `secret` substring rule (`log-redact.ts`) and the
  Fastify redact paths (`server.ts`), and never handing the raw key to Strom (only presigned
  URLs leave the backend). The `role` tag + §7 docs push operators toward least-privilege
  (read+list for clips, write for recordings).
- **SSRF via operator-named endpoint.** An `API_KEY` holder could aim the signer at an internal
  service or the cloud metadata endpoint. *Mitigation:* §5 default-deny private hosts, narrow
  allowlist only, the same non-overridable format guards as the SRT path. The allowlist is
  strictly narrower than a boolean. Residual: DNS-name endpoints are not resolved synchronously
  (shared limitation with `httpUrlOnly`).
- **Listing enumeration / cost.** A huge bucket or a pathological prefix could be walked.
  *Mitigation:* server-side `STORAGE_LIST_MAX_KEYS` cap, delimiter-scoped (no recursion),
  cursor-paged, read-only, same `API_KEY` gate.
- **Dangling reference.** A connection deleted while a source/output/recording points at it would
  break Cue or playback. *Mitigation:* §2.6 `409` delete-guard across sources, outputs, and
  recordings; playback degrades to "no `playbackUrl`" (not a crash) for the already-tolerated
  mismatch case.
- **Key loss / rotation.** If `STORAGE_CONNECTION_KEY` (or the stored fallback) is lost, every
  `secretKeyEnc` is unrecoverable and connections must be re-entered. *Mitigation:* same posture
  and fail-closed-in-production semantics as SRT/HTML keys; document rotation (re-PATCH each
  secret under the new key), as with the other credential families.
- **Test/probe as an oracle.** The test endpoint reveals endpoint reachability and bucket
  existence. *Mitigation:* it is behind the same `API_KEY` gate as everything else, returns no
  credentials, and runs the same SSRF endpoint validation as create — it cannot be used to probe
  a non-allow-listed private host.
```
