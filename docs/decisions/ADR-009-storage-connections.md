# ADR-009: Storage-connection secrets use the shared credential-encryption key family, and private endpoints are gated by a `TRUSTED_STORAGE_HOSTS` allowlist

**Date**: 2026-10-16
**Status**: Proposed

> Proposed by `architect` in Phase 1 for Eyevinn/open-live#520 (OL-21). Full design in
> `docs/specs/storage-connections.md`. This ADR settles the two design choices that cross a
> service/data-model boundary and carry long-term security consequences: (1) which key
> encrypts a storage connection's secret key at rest, and (2) how an operator-supplied storage
> endpoint is constrained against SSRF. The spec's remaining open question (OQ3 — whether the
> shared OSC Strom may reach arbitrary customer endpoints) is a cross-service security premise
> left flagged for a human in the spec, not decided here.

## Context

Object storage is configured once per instance via `MINIO_*` / `S3_ENDPOINT`, so there is one
store and one key pair per instance (`src/lib/recording-uploader.ts:124-152`,
`src/config.ts:273-278`). Issue #520 makes storage a first-class, operator-managed
`StorageConnection` resource. Two of its design choices are not local to one route:

1. **A storage connection stores a secret key** (the object-store secret access key). Open Live
   already has a hardened house pattern for an at-rest secret:
   - AES-256-GCM, self-describing `encv1:` wire prefix, fail-closed in production
     (`src/lib/srt-passphrase-crypto.ts:38-82`, used by SRT passphrases and HTML-source auth).
   - A `KeySource` abstraction (`srt-passphrase-crypto.ts:54-82`) that resolves, per credential
     kind, a dedicated env var first and an optional **stored** backend-generated fallback
     second. The shared backend-generated key (`src/lib/credential-encryption-key.ts`, #438)
     makes credential storage work zero-config on OSC, where no key env var is provisioned.
   - A **split** in that family: SRT and HTML fall back to the *shared* stored key; RTMP stream
     keys use a *dedicated* `RTMP_CREDENTIALS_KEY` with their OWN stored provider and never touch
     the shared key (ADR-004 Resolved Decision 2, `rtmp-credential-key.ts`, #447) — to keep RTMP
     rotation blast-radius isolated.
   So the decision is not "how to encrypt" (that is settled: `encv1:`/AES-256-GCM) but **which
   key family** a storage secret joins — the shared-stored family (SRT/HTML) or an isolated one
   (RTMP). This is the spec's Open Question 1.

2. **A storage connection's endpoint is operator-supplied.** The backend SigV4-signs and sends
   requests to that host. Today the host is the fixed `MINIO_ENDPOINT`; making it a per-resource,
   `API_KEY`-writable field re-creates exactly the SSRF surface that `httpUrlOnly()` /
   `isPrivateHost()` guard for clip `url` references (`src/lib/url-validation.ts:34-60`), and that
   #78/#58 and the `TRUSTED_SRT_HOSTS` allowlist
   (`docs/specs/configurable-srt-private-host-allowlist.md`) already addressed for SRT. The spec's
   Open Question 2 is how to allow a legitimate private endpoint (self-hosted MinIO on a LAN)
   without reopening the RFC1918 + loopback + cloud-metadata surface to any `API_KEY` holder.

Constraints: OSC instances must stay zero-config (no key provisioning); self-hosted deployments
must be able to pin/rotate their own key and reach their own private MinIO; the SSRF default must
stay safe (default-deny) and must not fork the SSRF logic into a second, separately-reviewed code
path.

## Decision

**Decision 1 — storage secrets join the SHARED credential-encryption key family (like SRT/HTML),
via a dedicated `STORAGE_CONNECTION_KEY` env override.** The connection secret key is encrypted
with the existing `encv1:` AES-256-GCM helper through a new `KeySource`:

- `envVar: "STORAGE_CONNECTION_KEY"` — an optional, self-hosted override that always wins when
  set (so operators can pin/rotate independently);
- `allowStoredKeyFallback: true` with **no** dedicated `storedKeyProvider`, so when the env var is
  unset it falls back to the **shared** backend-generated credential-encryption key (#438) — the
  same key SRT and HTML already use.

Storage secrets do **not** get an isolated stored-key family like RTMP's. The secret is write-only
over the API (accepted on create/patch, never returned; the view exposes only `secretKeySet:
boolean`), never logged in plaintext (the `secret` redaction rule), and never handed to Strom —
only short-lived presigned URLs leave the backend.

**Decision 2 — private/loopback/link-local endpoints are default-denied and relaxed only through a
`TRUSTED_STORAGE_HOSTS` deployment allowlist.** A new pure helper `storageEndpointHost(endpoint,
trustedStorageHosts)` in `url-validation.ts` normalises the endpoint to `host[:port]` (reusing
`minioTargetFromConfig`'s scheme/SSL normalisation) and rejects a host that `isPrivateHost()`
flags **unless** it matches an entry in `TRUSTED_STORAGE_HOSTS` (bare IP literal or CIDR). This
reuses the `TRUSTED_SRT_HOSTS` matcher verbatim (same CIDR / IPv4-mapped-IPv6 canonicalisation),
so there is a single SSRF matching implementation. Default (unset) blocks every private endpoint.
It is **not** a per-connection allow flag and **not** a global boolean.

## Consequences

**Positive**:
- Reuses already-hardened, already-reviewed machinery: the `encv1:`/AES-256-GCM helper, the
  `KeySource`/stored-key fallback, the `secretKeySet` write-only posture (ADR-003/ADR-004), the
  `TRUSTED_SRT_HOSTS` SSRF matcher, and `isPrivateHost()`. Little net-new security-sensitive code.
- Zero-config on OSC (shared stored key) and self-host-friendly (env override + host allowlist).
- One SSRF code path to audit for both SRT and storage endpoints; default-deny is the safe
  posture and is strictly narrower than a boolean.

**Negative**:
- A storage secret sharing the stored credential key means rotating that shared key re-encrypts
  SRT, HTML, **and** storage secrets together — a wider blast radius than RTMP's isolated key. This
  is accepted (see Alternatives): object-store credentials are the same tier as SRT passphrases,
  not a separate-rotation case, and an operator who wants isolation can set `STORAGE_CONNECTION_KEY`.
- Another env var (`STORAGE_CONNECTION_KEY`) and another allowlist (`TRUSTED_STORAGE_HOSTS`) to
  document and, for self-host, to provision.
- DNS-name endpoints are not resolved synchronously, so the SSRF guard blocks the direct-IP vector
  only (a shared limitation with `httpUrlOnly`; a resolving guard is a cross-cutting follow-up).

**Risks**:
- **Over-broad allowlist** (`0.0.0.0/0`, `169.254.0.0/16`) re-opens the metadata surface.
  *Detection/mitigation:* default empty; only listed ranges relaxed; non-overridable format guards;
  docs warn against metadata/wildcard ranges (as in the SRT spec). Misconfigured CIDR entries
  fail closed (never match).
- **Shared-key loss** makes SRT + HTML + storage secrets unrecoverable at once. *Mitigation:*
  same fail-closed-in-production posture and stored-key durability (#438) already in production;
  document the shared blast radius so an operator needing isolation sets the dedicated env key.
- **Secret leak via a new path** (logs, API, Strom). *Mitigation:* write-only API, `secret`
  redaction, presigned-URL-only to Strom; a `security-engineer` review of the create/test/listing
  flow is recommended before Phase 2, as for RTMP.

## Alternatives Considered

- **Reuse `SRT_PASSPHRASE_KEY` directly with no dedicated env var (just the shared stored key).**
  *Rejected.* It works, but a dedicated `STORAGE_CONNECTION_KEY` override costs one `KeySource`
  entry and lets self-hosted operators pin/rotate storage independently without disturbing SRT —
  matching how HTML took `HTML_AUTH_KEY` (ADR-003). The shared stored-key *fallback* is retained
  for zero-config OSC; only the override is added.
- **A fully isolated stored-key family like RTMP's `RTMP_CREDENTIALS_KEY` (own stored provider,
  never shares).** *Rejected for v1.* RTMP's isolation exists because stream-key rotation is a
  frequent, platform-driven operation that must not force rotation of unrelated secrets. Object-
  store credentials rotate on the same cadence as other infra secrets and sit in the same trust
  tier as SRT passphrases; the shared family keeps the stored-key surface to one key on OSC. An
  operator who still wants isolation gets it by setting `STORAGE_CONNECTION_KEY`. Not precluded as
  a later change if storage rotation proves to need RTMP-style isolation.
- **Per-connection `allowPrivateEndpoint` boolean.** *Rejected.* It lets any `API_KEY` holder
  self-authorise a signed request to an internal service or the cloud metadata endpoint — the data
  path is the attack, so the resource itself must not carry its own SSRF escape hatch. The
  authority to reach private ranges belongs in deployment config, not in an API-writable field.
- **Global `ALLOW_PRIVATE_STORAGE=true` boolean.** *Rejected.* Re-opens the entire RFC1918 +
  loopback + link-local + 169.254 surface at once (same reasoning as the SRT spec §2). The
  allowlist is a strict superset of its safety and names only the hosts an operator controls.
- **No endpoint SSRF guard (trust the `API_KEY`).** *Rejected.* The `API_KEY` authorises using the
  product, not aiming the server's SigV4 signer at arbitrary internal hosts; the clip `url` path
  already rejects private targets, and a storage endpoint is the same vector.
```
