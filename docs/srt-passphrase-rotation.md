# SRT Passphrase Rotation & Compromise Response

Operator runbook for rotating an SRT source passphrase and for responding to a
suspected exposure of stored passphrases (e.g. direct CouchDB access).

Audience: operators running a production Open Live deployment. Assumes access to
the Open Live API (and/or the studio UI) and, for incident response, to the
CouchDB instance backing the deployment.

## Background: how SRT passphrases are stored

SRT sources are defined as **source** documents. The passphrase is not a
separate field — it is embedded in the source `address` as the `passphrase`
query parameter of the SRT URI:

```
srt://host:9000?passphrase=<secret>&latency=200
```

When a source is created (`POST /api/v1/sources`) or its address is updated
(`PATCH /api/v1/sources/:id`), the server encrypts **only** the `passphrase`
query parameter before the document is written to CouchDB. Everything else
(host, port, other params) stays in cleartext. The stored value looks like:

```
srt://host:9000?passphrase=encv1:<base64url-bundle>&latency=200
```

- Encryption is AES-256-GCM. The key comes from the `SRT_PASSPHRASE_KEY`
  environment variable (32 bytes, base64 or hex). This is **required in
  production** — the server refuses to start without it. In non-production it
  falls back to storing plaintext with a loud startup warning.
- The `encv1:` prefix marks an encrypted value. Legacy documents written before
  encryption was added hold the passphrase in plaintext and pass through
  unchanged (see #160).
- The passphrase is decrypted only when handing the URI to the Strom pipeline
  engine at activation, and is **masked** (`passphrase=***`) in every API
  response and redacted in logs. It is never returned to clients in cleartext.

Source code of record (verify before relying on this doc):

- `src/lib/srt-passphrase-crypto.ts` — encrypt/decrypt, key loading, `encv1:`
  wire format.
- `src/routes/sources.ts` — create (`encryptAddressPassphrase` on `POST`,
  lines ~101–102), update (`PATCH`, lines ~146–150), and response masking
  (`toApi` / `maskSrtPassphrase`, lines ~66–77).
- `src/lib/flow-generator.ts` — decrypts the address at activation before it is
  passed to Strom (lines ~74–77).
- `src/lib/log-redact.ts` and `src/server.ts` — log redaction of `passphrase`,
  `srt_uri`, `streamid`, tokens and secrets.

> **There is no dedicated "rotate passphrase" endpoint.** Rotation is performed
> by updating the source address through the existing source API, which
> re-encrypts and rewrites the stored value. See "Tooling gaps" below.

## Rotating an SRT passphrase

Rotation means changing the passphrase on both ends of the SRT link: the
upstream sender/encoder that originates the stream **and** the Open Live source
document that Open Live uses to connect. Coordinate both — a mismatch breaks the
handshake and the source will not connect.

### Steps

1. **Pick a new passphrase** on the upstream encoder/sender. SRT requires
   10–79 characters. Generate a strong random value, for example:

   ```bash
   openssl rand -base64 24
   ```

2. **Identify the source.** Find its ID via the API (the response masks the
   passphrase, so you will not see the old secret):

   ```bash
   curl -s "$OPEN_LIVE_URL/api/v1/sources" | jq '.[] | {id, name, address, streamType}'
   ```

3. **Update the upstream encoder** to use the new passphrase. If the source is
   currently live, expect the SRT link to drop and reconnect once both sides
   agree on the new value (see "What to expect" below). Schedule this during a
   maintenance window for active productions.

4. **Update the Open Live source** with the full SRT address carrying the new
   passphrase. `PATCH` the source with the complete `address`:

   ```bash
   curl -s -X PATCH "$OPEN_LIVE_URL/api/v1/sources/<source-id>" \
     -H 'content-type: application/json' \
     -d '{"address":"srt://host:9000?passphrase=<NEW_SECRET>&latency=200"}'
   ```

   (The studio UI's edit-source form does the same thing — it sends the new
   address on save.)

   On save the server:
   - validates the SRT URI (`srtUrl()`),
   - encrypts the new `passphrase` param (`encryptAddressPassphrase`),
   - overwrites the stored `address` on the source document, replacing the old
     encrypted value in place, and
   - returns the source with the passphrase masked.

   The old ciphertext is no longer present in the current revision of the
   document. **Note:** CouchDB retains prior document revisions until database
   compaction runs, so the previous encrypted value can linger in `_rev`
   history. This is not a plaintext exposure (the old value is also encrypted),
   but if you are rotating *because of* a suspected key/DB compromise, follow the
   compromise-response section, which addresses revision history and key
   rotation.

5. **Re-activate the affected production(s)** so the new passphrase reaches the
   Strom pipeline. The decrypted address is baked into the flow at activation
   time (`flow-generator.ts`), so a source edit does **not** propagate to an
   already-running flow:

   ```bash
   curl -s -X POST "$OPEN_LIVE_URL/api/v1/productions/<prod-id>/deactivate"
   curl -s -X POST "$OPEN_LIVE_URL/api/v1/productions/<prod-id>/activate"
   ```

6. **Verify** the source reconnects and video/audio is flowing in the
   multiviewer.

### What to expect

- **Reconnection, not seamless rotation.** SRT has no in-band passphrase
  rehandshake. Changing the passphrase forces the link to renegotiate: the
  existing SRT session drops and a new one is established once both ends use the
  matching value. Expect a brief loss of that source's feed.
- **Order matters.** During the window between updating one end and the other,
  the source will fail to connect (passphrase mismatch). Keep that window short.
- **Running flows are not auto-updated.** You must deactivate/reactivate the
  production for the new passphrase to take effect (step 5).
- **Other productions sharing the source** are all affected — sources are
  referenced by `sourceId`, so one edit changes the passphrase for every
  production using that source.

## Detecting & responding to a suspected compromise

Treat the passphrase as compromised if any of the following occur: direct/
unauthorised access to CouchDB (see #62), leakage of the `SRT_PASSPHRASE_KEY`,
exposure of a `.env`/parameter-store value, or an unexplained unauthorised SRT
connection to a listener.

### Detect

- **Direct CouchDB exposure.** The highest-risk path is the CouchDB admin API
  being reachable off-host (issue #62 — port 5984 bound to `0.0.0.0` in the
  default `docker-compose.yml`). Anyone who can reach CouchDB can read the
  `sources` documents directly. Check exposure:

  ```bash
  # From a host that should NOT have DB access — should fail/refuse to connect:
  curl -sS http://<couchdb-host>:5984/_up
  # Inspect what is stored (from an authorised host):
  curl -s "$COUCHDB_URL/open-live/_all_docs?include_docs=true" \
    | jq '.rows[].doc | select(.type=="source") | {_id, address}'
  ```

  - If `address` values show `passphrase=encv1:...`, the passphrase is encrypted
    at rest — an attacker with DB-only access cannot read it **unless** they also
    hold `SRT_PASSPHRASE_KEY`.
  - If `address` values show a plaintext `passphrase=<secret>`, this is a legacy
    document (predates #160) or the deployment ran without `SRT_PASSPHRASE_KEY`.
    **Treat every such passphrase as exposed** and rotate it.

- **Key exposure.** If `SRT_PASSPHRASE_KEY` may have leaked, all `encv1:` values
  are decryptable by the attacker — treat every SRT passphrase in the DB as
  compromised regardless of encryption.

- **Never grep logs for the secret** — passphrases are redacted in logs by
  design (`log-redact.ts`, `server.ts`). Absence from logs is expected and is
  not evidence of safety.

### Respond

1. **Contain the exposure first.**
   - Lock down CouchDB: bind it to localhost / an internal network only and put
     it behind auth, addressing #62. Do this before rotating, otherwise new
     values are exposed too.
   - If `SRT_PASSPHRASE_KEY` leaked, treat it as burned.

2. **Rotate every affected passphrase** using the rotation procedure above
   (upstream + source `PATCH` + production re-activation) for each affected
   source. Prioritise active/listener-mode sources.

3. **Rotate the encryption key if it was (or may have been) exposed.** There is
   **no automated key-rotation or re-encryption tool** (tooling gap). The manual
   path is:
   - Generate a new key: `openssl rand -base64 32`.
   - Because rotating individual passphrases (step 2) re-`PATCH`es each source,
     those values get re-encrypted with the current key. Perform the key swap and
     the passphrase rotations together: set the new `SRT_PASSPHRASE_KEY`, restart
     the server, then re-`PATCH` every SRT source so its `address` is re-written
     (and thus re-encrypted under the new key). Any source not re-`PATCH`ed still
     holds ciphertext under the old key and will fail to decrypt after the key
     changes — audit that all SRT sources were touched.

4. **Purge stale ciphertext from revision history.** Rotating rewrites the
   current revision, but CouchDB keeps old `_rev`s (which may contain the
   old ciphertext, or legacy plaintext) until compaction. After rotating, run
   database compaction to discard old revisions:

   ```bash
   curl -s -X POST "$COUCHDB_URL/open-live/_compact" -H 'content-type: application/json'
   ```

   For legacy plaintext exposure this is important — the old plaintext lives in
   revision history until compacted.

5. **Verify** each affected production reconnects with the new passphrase and
   monitor for further unauthorised connection attempts.

## Tooling gaps (known limitations)

Documented honestly so operators know where manual steps are required:

- **No first-class rotation endpoint.** Rotation reuses `PATCH
  /api/v1/sources/:id`; there is no single "rotate" action, and no server-side
  coordination with the upstream encoder.
- **No automatic propagation to running flows.** A source edit requires a manual
  production deactivate/reactivate.
- **No key-rotation / bulk re-encryption tooling.** Changing
  `SRT_PASSPHRASE_KEY` requires manually re-`PATCH`ing every SRT source; there
  is no migration command, and no detection of documents left encrypted under an
  old key.
- **No automatic revision-history purge.** Old ciphertext/plaintext persists in
  CouchDB `_rev` history until compaction is run manually.

## Related work

- **#160 — Encrypt SRT passphrases at rest before storing in CouchDB**
  (implemented). Provides the `encv1:` encryption-at-rest described above.
- **#80 — SRT passphrases stored in plaintext in CouchDB** (parent; closed).
  The original finding that motivated encryption-at-rest and this runbook.
- **#62 — CouchDB admin port 5984 bound to `0.0.0.0` in docker-compose**
  (open). The primary direct-DB-exposure vector referenced in the detection
  steps. Until closed, treat network access to CouchDB as a live risk.
