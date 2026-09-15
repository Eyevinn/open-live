# Spec: OL-5 Studio Gateways — Phase 1 (read-only heartbeat) backend design

**Status: Proposed** (architect draft for epic #263)
**Author:** architect agent
**Related issues:** #263 (OL-5 epic). Companion issues (out of scope here): open-live-studio#122
(Gateways tab + Sources chip), open-live-ingest#6 (heartbeat WS client).
**Reuses:** the merged health vocabulary from `docs/specs/production-lifecycle-health.md`
(PR #256, closing #255/OL-4) and the WS envelope (`seq`/`ts`, `HELLO`/`SNAPSHOT_END`) from
`docs/specs/automation-control-contract.md` (#209, PR #221).
**Related ADR:** `docs/decisions/ADR-001-per-gateway-auth-token.md`.

> Proposed spec, not an accepted decision. This covers **only** the open-live backend slice of
> Phase 1: a first-class `Gateway` resource, a per-gateway auth token, and an inbound heartbeat
> WebSocket endpoint. All changes are additive and backward-compatible. Phase 2 (Start/Stop) and
> Phase 3 (device picking) are documented in the epic but are **not** designed here.

## Problem Statement

`open-live-ingest` turns a venue laptop/box into a contribution gateway: it drives a local Strom,
encodes camera feeds and registers them as SRT sources in Open Live. Today the only operator
surface for that box is SSH plus its own CLI (`status`, `status --json`, `devices`, `up`/`down`).
A producer cannot tell from Open Live whether a venue's gateway is reachable, whether its cameras
are live, or what it is about to register, without shelling into the box.

Open Live has no concept of a gateway at all. Sources (`SourceDoc`, `src/db/types.ts:31`) are
flat SRT/WHIP/HTML endpoints with no notion of *which box produced them*. There is no inbound
status channel from an ingest box, and the only credential an ingest box holds today is the shared
Open Live `API_KEY` / OSC token it uses to register sources — an over-broad, shared credential
(the failure mode tracked as open-live-studio#10).

Phase 1 closes the read-only half of this gap in the backend:

1. `Gateway` as a first-class REST resource (`id`, `name`, `lastSeenAt`, `health`).
2. A **per-gateway auth token**, distinct from the shared API key, so the gateway authenticates
   *as itself* on the heartbeat socket (see ADR-001).
3. An **inbound heartbeat WebSocket endpoint** ingesting gateway status: online/offline,
   heartbeat age, host, local Strom version, device/streaming counts, and per-input flow
   state + uplink stats.

## Goals / Non-goals

**Goals (this spec, Phase 1, open-live backend only):**
1. Persist a `Gateway` CouchDB doc and expose read + lifecycle REST endpoints
   (`create` / `list` / `get` / `rotate-token` / `forget`).
2. Issue a per-gateway bearer token on gateway creation; store only its hash (ADR-001).
3. Accept an inbound heartbeat WS connection authenticated by that per-gateway token, ingest
   status snapshots, and derive gateway `health` from heartbeat recency.
4. Reuse the `healthy | down | unknown` vocabulary from OL-4 — **no** second health enum.
5. Reuse #209's envelope shape (`seq`/`ts`, `HELLO`/`SNAPSHOT_END`) on the new socket rather than
   inventing a second WS dialect.
6. Ship the "forget gateway" cascade (offline-gated), so zombie gateways/sources are removable.

**Non-goals (Phase 1):**
- Any command sent *to* the gateway (Start/Stop, "Test pattern", device picking). The heartbeat
  socket is **outbound-only from the gateway** in Phase 1 — Open Live never pushes control frames.
  Start/Stop is Phase 2; device picking is Phase 3.
- The Studio UI (Gateways tab, Sources chip) — that is open-live-studio#122.
- The ingest-side WS client — that is open-live-ingest#6.
- Any `degraded` health value — not introduced, matching the OL-4 decision (no verified per-output
  signal from Strom).
- Linking a `Source` to the `Gateway` that produced it is specified additively here (an optional
  `gatewayId` field) so the "forget → cascade sources" action and Studio's Sources chip have an
  anchor, but auto-tagging sources at registration time is a small follow-up, not blocking.

## API Design

All REST paths follow the existing `/api/v1/...` convention and the existing error envelope
`{ error: string, statusCode: number }` (see `src/routes/sources.ts`, `src/server.ts:341`).
All new routes sit behind the existing `API_KEY` bearer gate (`src/server.ts:265`) — i.e. Studio
and operators call them with the *shared* Open Live key exactly like `/api/v1/sources`. The
**per-gateway** token is used **only** on the heartbeat WS upgrade, never on these REST routes
(see ADR-001 for why the two credentials are separate).

Bodies are validated with `zod` in the route module, matching `SourceInput`/`SourcePatch`.

### 1. `POST /api/v1/gateways` — register a gateway, mint its token

Creates a `Gateway` and returns the per-gateway token **once** (it is never retrievable again;
only its hash is stored — ADR-001).

Request body:
```jsonc
{
  "name": "Venue A — main truck"   // required, 1..256 chars
}
```

Response `201`:
```jsonc
{
  "id": "gw-3f2a…",
  "name": "Venue A — main truck",
  "health": "unknown",             // no heartbeat seen yet
  "lastSeenAt": null,
  "createdAt": "2026-09-15T18:30:00.000Z",
  "updatedAt": "2026-09-15T18:30:00.000Z",
  "token": "olgw_v1_<opaque-secret>"  // RETURNED ONCE — store it in the ingest box now
}
```
Errors: `400` validation, `401` missing/invalid API key, `503` DB unavailable.

### 2. `GET /api/v1/gateways` — list gateways

Response `200`: array of gateway objects (the shape above **without** `token`), health
recomputed on read (see §"Health derivation"):
```jsonc
[
  {
    "id": "gw-3f2a…",
    "name": "Venue A — main truck",
    "health": "healthy",
    "lastSeenAt": "2026-09-15T18:31:12.400Z",
    "host": "venue-a-box.local",
    "stromVersion": "0.42.1",
    "deviceCount": 4,
    "streamingCount": 2,
    "inputs": [
      { "inputId": "cam-1", "name": "Camera 1", "flowState": "playing",
        "sourceId": "src-abc", "uplink": { "bitrateKbps": 6200, "rtt_ms": 18, "dropped": 0 } },
      { "inputId": "cam-2", "name": "Camera 2", "flowState": "idle",
        "sourceId": null, "uplink": null }
    ],
    "createdAt": "…",
    "updatedAt": "…"
  }
]
```
The `host`, `stromVersion`, `deviceCount`, `streamingCount`, `inputs` fields reflect the **last
heartbeat snapshot** (absent until the first heartbeat arrives). Errors: `401`, `503`.

### 3. `GET /api/v1/gateways/:id` — get one gateway

Response `200`: single gateway object (same shape as a list element). `404` if not found;
`401`, `503` as above.

### 4. `POST /api/v1/gateways/:id/rotate-token` — rotate the per-gateway token

Mints a new token, replaces the stored hash, invalidates the old token. Returns the new token
**once**. Used when a venue box is re-imaged or a token is suspected leaked (ADR-001).

Response `200`:
```jsonc
{ "id": "gw-3f2a…", "token": "olgw_v1_<new-opaque-secret>" }
```
Errors: `404` not found, `401`, `503`.

### 5. `DELETE /api/v1/gateways/:id` — "forget" a gateway (offline-gated cascade)

Deletes the gateway and, optionally, cascades to the sources it produced. **Guard:** refuse
unless the gateway has been offline for at least `GATEWAY_FORGET_MIN_OFFLINE_SECONDS`
(default 300s) — this is the epic's "zombie-sources escape hatch" and must not let an operator
delete a *live* gateway out from under a running show.

Query params:
- `cascadeSources` (bool, default `false`): also delete `Source` docs with `gatewayId === :id`.

Behaviour:
- If the gateway's derived `health` is `healthy` (a fresh heartbeat is within the down threshold),
  respond `409 { error: "Gateway is still online; cannot forget a live gateway", statusCode: 409 }`.
- If `cascadeSources=true`, each candidate source is deleted **using the same active-production
  guard `DELETE /api/v1/sources/:id` already enforces** (`src/routes/sources.ts:207`): a source
  in an `active`/`activating` production is **not** deleted; instead it is unlinked
  (`gatewayId` cleared) and reported in the response so it is not orphaned mid-broadcast.
- Non-cascade delete leaves sources in place but clears their `gatewayId` (they become plain
  manually-managed sources).

Response `200`:
```jsonc
{
  "id": "gw-3f2a…",
  "deletedSources": ["src-abc"],
  "keptSources": [ { "id": "src-def", "reason": "in active production \"Show 1\"" } ]
}
```
Errors: `404` not found, `409` still online, `401`, `503`.

> `204 No Content` is the existing convention for `DELETE /api/v1/sources/:id`, but this endpoint
> returns a `200` body because the cascade result (which sources were deleted vs kept) is
> operationally important information the caller needs. This is a deliberate, documented deviation.

### 6. Heartbeat WebSocket: `GET /ws/gateways/:id/heartbeat`

An **inbound** socket the *gateway* dials to Open Live to push status. Registered exactly like the
existing controller socket (`fastify.get(..., { websocket: true }, ...)`,
`src/ws/controller.ts:1586`). Phase 1 is **gateway → Open Live only** for status; Open Live sends
back only envelope/ack frames (`HELLO`, `SNAPSHOT_END`, `ACK`, `ERROR`) — no control commands.

#### Auth handshake

The gateway authenticates with **its own per-gateway token**, not the shared API key. Because the
ingest box is a non-browser client, it presents the token as a bearer credential. Two accepted
transports mirror the existing WS auth split (`src/server.ts:291-299`):

- **Preferred (non-browser):** `Authorization: Bearer olgw_v1_<secret>` on the upgrade request.
- **Subprotocol fallback:** `Sec-WebSocket-Protocol: openlive.gateway.<token>` (mirrors the
  existing `openlive.bearer.<key>` sentinel, `src/server.ts:296`), so the marker (never the
  secret) is echoed back via `handleProtocols` (`src/server.ts:231`).

The token is verified against the stored hash for the gateway `:id`. The token is **never**
accepted in the `?key=` query string (same rule as #49). On mismatch or unknown `:id`, the server
completes the upgrade and immediately sends `ERROR { code: "unauthorized" }` then closes with WS
close code `4401` (application "unauthorized"). Auth is enforced in the same `onRequest` hook that
guards `/ws/` today (`src/server.ts:283-285`) extended to recognise the gateway path + per-gateway
token; the shared `API_KEY` alone does **not** grant heartbeat access.

#### Message envelope

Every frame reuses #209's envelope: `type`, `seq` (per-gateway monotonic int, resets on server
restart), `ts` (ISO 8601 UTC).

**Server → gateway (connect sequence, mirrors #209 `HELLO`…`SNAPSHOT_END`):**
```jsonc
{ "type": "HELLO", "contractVersion": "1.0.0", "gatewayId": "gw-3f2a…", "seq": 0, "ts": "…" }
{ "type": "SNAPSHOT_END", "seq": 1, "ts": "…" }   // nothing to replay to the gateway in Phase 1
```

**Gateway → server (status ingest):**

`GATEWAY_ONLINE` — first frame after `HELLO`, and whenever identity metadata changes:
```jsonc
{
  "type": "GATEWAY_ONLINE",
  "seq": 1,
  "ts": "2026-09-15T18:31:12.400Z",
  "host": "venue-a-box.local",
  "stromVersion": "0.42.1",
  "deviceCount": 4,
  "streamingCount": 2
}
```

`HEARTBEAT` — periodic status snapshot (recommended every 5s, see Configuration). Carries the
same fields `open-live-ingest status --json` already computes:
```jsonc
{
  "type": "HEARTBEAT",
  "seq": 2,
  "ts": "2026-09-15T18:31:17.400Z",
  "host": "venue-a-box.local",
  "stromVersion": "0.42.1",
  "deviceCount": 4,
  "streamingCount": 2,
  "inputs": [
    {
      "inputId": "cam-1",
      "name": "Camera 1",
      "flowState": "playing",          // idle | playing | paused — Strom FlowState vocabulary
      "sourceId": "src-abc",           // the Open Live source this input registered as, if any
      "uplink": { "bitrateKbps": 6200, "rtt_ms": 18, "dropped": 0 }
    }
  ]
}
```

`GATEWAY_OFFLINE` — best-effort graceful shutdown notice (the box announces it is going down):
```jsonc
{ "type": "GATEWAY_OFFLINE", "seq": 9, "ts": "…", "reason": "operator-stop" }
```

**Server → gateway (per-frame ack, optional, mirrors #209 `ACK`/`NACK`):**
```jsonc
{ "type": "ACK", "ackSeq": 2, "seq": 3, "ts": "…" }          // heartbeat ingested
{ "type": "ERROR", "code": "invalid_frame" | "unauthorized", "seq": 4, "ts": "…" }
```

Forward-compat rule (inherited from #209): both sides MUST ignore unknown frame types and unknown
fields. This lets Phase 2 add downstream control frames (`START`, `STOP`) without a major bump.

#### Error / status codes summary

REST: `400` invalid body, `401` missing/invalid **shared API key**, `404` unknown gateway,
`409` state conflict (forget a live gateway), `503` DB unavailable. WS: application close code
`4401` unauthorized (bad/missing **per-gateway** token), `ERROR` frames for in-band problems.

## Data Model

CouchDB via `nano`, one physical `open-live` database with a per-collection type discriminator and
the `withTypeGuard` wrapper (`src/db/index.ts:73`). A new collection accessor
`getGatewaysDb()` is added following the exact pattern of `getSourcesDb()`
(`src/db/index.ts:127`), re-typing the shared handle and asserting `type: 'gateway'`.

### New `GatewayDoc` (`src/db/types.ts`)

```ts
export type GatewayHealth = 'healthy' | 'down' | 'unknown';   // reused from OL-4 — no new enum

export type GatewayInputFlowState = 'idle' | 'playing' | 'paused'; // Strom FlowState (strom.ts:126)

export interface GatewayInputStatus {
  inputId: string;
  name: string;
  flowState: GatewayInputFlowState;
  sourceId: string | null;        // references SourceDoc._id when this input registered a source
  uplink: { bitrateKbps: number; rtt_ms: number; dropped: number } | null;
}

export interface GatewayDoc {
  _id: string;                     // "gw-<uuid>"
  _rev?: string;
  type: 'gateway';
  name: string;
  /** SHA-256 hash of the per-gateway bearer token. Raw token is never persisted (ADR-001). */
  tokenHash: string;
  /** ISO 8601 UTC time of the most recent heartbeat/online frame; null until first contact. */
  lastSeenAt: string | null;
  // ---- last-heartbeat snapshot (all optional; absent until first heartbeat) ----
  host?: string;
  stromVersion?: string;
  deviceCount?: number;
  streamingCount?: number;
  inputs?: GatewayInputStatus[];
  createdAt: string;
  updatedAt: string;
}
```

`health` is **not** stored — it is derived on read from `lastSeenAt` (see below), the same
"compute-on-read" approach OL-4 uses for output health. This avoids a background writer just to
flip a persisted flag and keeps every read truthful.

### Additive change to `SourceDoc` (`src/db/types.ts`)

```ts
  /** Optional id of the Gateway that registered this source. Absent for manually-created
   *  sources. Enables the forget-gateway cascade and Studio's Sources chip. */
  gatewayId?: string;
```
Optional and defaulted-absent — every existing source stays valid unchanged.

### Health derivation (compute-on-read)

Given `now` and `lastSeenAt`, with `GATEWAY_DOWN_AFTER_SECONDS` (default 15s):
- `unknown` — `lastSeenAt` is `null` (never contacted).
- `healthy` — `now - lastSeenAt <= GATEWAY_DOWN_AFTER_SECONDS`.
- `down` — `now - lastSeenAt > GATEWAY_DOWN_AFTER_SECONDS`.

No `degraded` value (consistent with OL-4). The default 15s tolerates two missed 5s heartbeats.

### Persistence on the heartbeat path

On each `GATEWAY_ONLINE` / `HEARTBEAT` frame the WS handler updates the gateway doc's
`lastSeenAt`, `host`, `stromVersion`, `deviceCount`, `streamingCount`, `inputs`, and `updatedAt`
via a conflict-retry write (reusing the `persistMixerMutation` re-read-on-409 pattern,
`src/ws/controller.ts:96`). To bound CouchDB write volume, only `lastSeenAt` + changed snapshot
fields are written, and identical back-to-back heartbeats debounce to at most one write per
`GATEWAY_HEARTBEAT_PERSIST_MIN_INTERVAL_MS` (default 5000ms).

### Migration / back-compat

No migration required. `GatewayDoc` is a brand-new type — no existing document is a gateway. The
added `SourceDoc.gatewayId` is optional; existing sources read unchanged and existing selectors
(`{ type: 'source' }`, `src/routes/sources.ts:87`) are unaffected. The Mango-injection guard and
type-guard (`src/db/index.ts`) apply to the new collection automatically via `getGatewaysDb()`.

## Service Interactions

```mermaid
sequenceDiagram
    participant Op as Operator / Studio
    participant OL as open-live (Fastify + WS)
    participant GW as open-live-ingest gateway
    participant S as local Strom (at venue)

    Op->>OL: POST /api/v1/gateways { name } (shared API key)
    OL->>OL: mint token, store SHA-256(token), write GatewayDoc (health=unknown)
    OL-->>Op: 201 { id, token }  (token shown once)
    Note over Op,GW: operator provisions the ingest box with { id, token }

    GW->>OL: WS connect /ws/gateways/:id/heartbeat<br/>Authorization: Bearer olgw_v1_… (per-gateway token)
    OL->>OL: verify token vs stored hash for :id
    alt token invalid / unknown id
        OL-->>GW: ERROR { code: unauthorized }, close 4401
    else authenticated
        OL-->>GW: HELLO { contractVersion, gatewayId, seq, ts }
        OL-->>GW: SNAPSHOT_END { seq }
        GW->>OL: GATEWAY_ONLINE { host, stromVersion, deviceCount, streamingCount }
        OL->>OL: write lastSeenAt, snapshot -> health=healthy
        loop every ~5s
            GW->>S: read local status (devices, flow state, uplink)
            GW->>OL: HEARTBEAT { inputs:[{flowState, uplink}], counts }
            OL->>OL: update lastSeenAt + snapshot (debounced write)
            OL-->>GW: ACK { ackSeq }
        end
        Note over OL: if now - lastSeenAt > DOWN_AFTER -> read as health=down
        GW-->>OL: (socket drops on venue-network loss; feed unaffected)
    end

    Op->>OL: GET /api/v1/gateways  (poll)
    OL-->>Op: [ { health, lastSeenAt, inputs, … } ]
```

## Configuration (env vars)

New backend settings follow the existing `config.ts` parse helpers
(`parsePositiveIntEnv`, `parseBoolEnv`). None are required (all have safe defaults). No new env
var is needed for token *issuance* — tokens are generated with `crypto.randomBytes` and hashed
with the built-in `crypto` module; there is no external secret store to wire up.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GATEWAY_DOWN_AFTER_SECONDS` | `15` | Heartbeat age past which a gateway reads as `down` |
| `GATEWAY_HEARTBEAT_INTERVAL_SECONDS` | `5` | Recommended cadence advertised in `HELLO` (advisory; the gateway drives its own timer) |
| `GATEWAY_HEARTBEAT_PERSIST_MIN_INTERVAL_MS` | `5000` | Min interval between CouchDB writes for a gateway's snapshot (write-rate cap) |
| `GATEWAY_FORGET_MIN_OFFLINE_SECONDS` | `300` | Minimum offline duration before `DELETE /gateways/:id` is allowed |

**Token issuance/storage:** a per-gateway token is a URL-safe random string prefixed `olgw_v1_`
(prefix enables key-scanning/rotation tooling and future format versioning). Only its SHA-256 hash
is stored in `GatewayDoc.tokenHash`; the raw token is returned exactly once, on create/rotate.
See ADR-001 for the full rationale and the choice of hash-only storage. Reuses the existing
`API_KEY` gate for the REST management surface — no new REST auth mechanism is introduced.

## Open Questions

Each carries a concrete recommended resolution; none is left as a bare "TBD".

**OQ-1 — Heartbeat frame authentication after the handshake (recommended: connection-scoped,
no per-frame signing).** Should each `HEARTBEAT` frame be individually authenticated (e.g. signed),
or is authenticating once at the WS upgrade sufficient? **Recommendation: authenticate once at the
upgrade, trust the connection thereafter** — this matches how the existing controller socket treats
an authenticated connection (`src/ws/controller.ts`), and per-frame signing adds cost with no
threat-model benefit over TLS + a connection-scoped token. Adopt unless a customer's threat model
demands per-frame integrity, in which case revisit in a follow-up.

**OQ-2 — Should sources be auto-tagged with `gatewayId` at registration time? (recommended: yes,
as a small follow-up, not blocking this spec).** The ingest box registers sources via the existing
`POST /api/v1/sources` today, which has no gateway identity. Cleanest is for the ingest client to
include its gateway id when registering (a one-line additive change to that flow) so the
forget-cascade and Sources chip have real links. **Recommendation: land the `gatewayId` field now
(done in this spec) and add auto-tagging as a follow-up task on open-live-ingest#6**; until then,
`gatewayId` can be set via the heartbeat `inputs[].sourceId` mapping, so the link is derivable.

**OQ-3 — Product call (needs a human): does Phase 1 ship a UI-less backend, or should the epic
gate backend merge on the Studio tab?** This is genuinely a product/sequencing decision, not a
technical one. **Recommendation (default): ship the backend independently** — it is useful on its
own (operators can poll `GET /api/v1/gateways`), the companion open-live-studio#122 is explicitly
"blocked on this spec", and #263's own phasing treats the backend slice as the unit that moves to
Ready. Flagging for **@birme / @svensson00**: if the team prefers to withhold the backend until the
Studio surface lands, that is a legitimate call, but it delays value and is not recommended.

**OQ-4 — Token rotation UX on a re-imaged venue box (recommended: rotate-token endpoint, provided).**
When a box is re-imaged it loses its token; the operator needs a new one without recreating the
gateway (which would break `gatewayId` links). **Recommendation: use `POST /gateways/:id/rotate-token`
(specified above)** — it preserves the gateway id and its source links while invalidating the old
credential. No open decision remains; documented here for completeness.

## Risks

- **Back-compat.** `GatewayDoc` is new and `SourceDoc.gatewayId` is optional; both are additive.
  The only risk is a client that hard-fails on the new optional source field — mitigated because
  existing responses only *add* a field, and clients ignore unknown fields (the #209 forward-compat
  rule). Existing source selectors are untouched.
- **Heartbeat write amplification.** A chatty gateway could hammer CouchDB. Mitigated by the
  debounced compute-on-read model (`GATEWAY_HEARTBEAT_PERSIST_MIN_INTERVAL_MS`) and by storing
  `health` nowhere (derived on read).
- **Forget-cascade deleting live sources.** Mitigated by the offline gate
  (`GATEWAY_FORGET_MIN_OFFLINE_SECONDS`) **and** by reusing the existing active-production delete
  guard per source (`src/routes/sources.ts:207`) so an in-broadcast source is never deleted.
- **Token leakage.** The raw token is returned once and only its hash is stored (ADR-001);
  rotation is available. The token is never accepted via query string and is redacted in logs like
  the existing bearer credentials (`src/server.ts:262`).
- **Scope creep into Phase 2/3.** The heartbeat socket is outbound-only from the gateway in Phase
  1; any PR adding a downstream control frame (`START`/`STOP`) or device-picking endpoint under
  cover of this spec must be rejected in review as out of Phase-1 scope.
