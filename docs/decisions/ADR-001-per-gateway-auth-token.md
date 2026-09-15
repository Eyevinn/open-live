# ADR-001: Per-gateway auth token for the heartbeat socket

**Date**: 2026-09-15
**Status**: Proposed

## Context

The OL-5 "Studio Gateways" epic (#263) introduces `open-live-ingest` venue boxes as first-class
`Gateway` resources that push status to Open Live over an inbound heartbeat WebSocket
(`GET /ws/gateways/:id/heartbeat`, see `docs/specs/studio-gateways.md`).

Today, an ingest box holds exactly one credential: the **shared** Open Live `API_KEY` / OSC token
it uses to register sources (`src/config.ts`, `src/server.ts:265`). That same key authenticates
every REST caller and every controller WebSocket client. If a venue box authenticated the
heartbeat socket with the shared key, then:

- Every venue box in a fleet would hold the *same* over-broad credential. A single compromised box
  (physically accessible at a venue, operated by non-Open-Live staff) would leak a key that can
  drive *any* production, not just report its own status. This is exactly the shared-over-broad
  credential failure mode already tracked as open-live-studio#10.
- Open Live could not attribute a heartbeat to a specific gateway by credential — it would have to
  trust the `:id` in the path, which any holder of the shared key could spoof.
- Revoking one venue's access (box lost/stolen/decommissioned) would require rotating the shared
  key and re-provisioning the entire fleet.

Constraints: the ingest box is a non-browser client (so it can send an `Authorization` header),
may be operated by customer-side non-technical staff, and connects over TLS. Open Live stores its
data in CouchDB via `nano` and already has a bearer-token auth pattern
(`Authorization: Bearer` / `Sec-WebSocket-Protocol: openlive.bearer.<key>`, `src/server.ts`).

## Decision

Issue a **distinct per-gateway bearer token**, separate from the shared Open Live `API_KEY`, and
require it (and only it) to authenticate the heartbeat WebSocket connection. Specifically:

- On `POST /api/v1/gateways`, generate a URL-safe random token prefixed `olgw_v1_` using the
  built-in `crypto` module. Return it to the caller **exactly once**.
- Persist only its **SHA-256 hash** in `GatewayDoc.tokenHash`. The raw token is never stored and
  never retrievable again.
- The gateway presents this token on the heartbeat WS upgrade as
  `Authorization: Bearer olgw_v1_<secret>` (or the `openlive.gateway.<token>` subprotocol
  fallback). The server verifies it against the stored hash for the path `:id`. The shared
  `API_KEY` alone does **not** grant heartbeat access; the per-gateway token does **not** grant
  access to any other REST/WS route.
- Provide `POST /api/v1/gateways/:id/rotate-token` to mint a replacement and invalidate the old
  token without recreating the gateway (preserving its id and its source links).

The REST management surface (`create`/`list`/`get`/`rotate`/`forget`) stays behind the existing
shared `API_KEY` gate — only the *gateway's own* heartbeat connection uses the per-gateway token.

## Consequences

**Positive**:
- Least privilege: a venue box can only *report its own status*; it cannot drive productions. A
  compromised box leaks a narrowly-scoped credential, directly avoiding the open-live-studio#10
  failure mode at the venue layer.
- Per-gateway attribution and revocation: each token maps to one gateway, so Open Live trusts the
  heartbeat's origin by credential (not by a spoofable path id), and one box can be revoked
  (via rotate-token) without touching the rest of the fleet.
- The identity model is designed in when the `Gateway` object is created — far cheaper than
  retrofitting scoped credentials onto a shared-token fleet later.
- Hash-only storage means a database read (backup leak, `find()` mishap) cannot recover live
  tokens.

**Negative**:
- A second credential type to manage: tokens must be provisioned onto boxes and rotated on
  re-imaging. Mitigated by the one-line rotate-token flow and the "shown once" UX.
- Slightly more code than reusing the shared key: token generation, hashing, per-gateway
  verification on the WS upgrade.

**Risks**:
- **Lost token → locked-out box.** Because the raw token is shown once, losing it means the box
  cannot reconnect. *Detection/mitigation:* `rotate-token` issues a fresh one; the gateway shows as
  `down` in `GET /api/v1/gateways` until re-provisioned, so the lockout is visible.
- **Token leakage in transit/logs.** *Mitigation:* TLS in transit; never accepted via `?key=`
  query string; redacted from request logs like existing bearer credentials
  (`src/server.ts:262`); rotatable on suspicion.
- **Hash algorithm longevity.** SHA-256 of a high-entropy random token is sufficient (the token is
  not a low-entropy password, so a slow KDF is unnecessary). The `olgw_v1_` prefix lets us version
  the format if this ever needs to change.

## Alternatives Considered

- **Reuse the shared `API_KEY` for the heartbeat socket.** Rejected: reproduces open-live-studio#10
  (one over-broad, shared, hard-to-revoke credential across the whole fleet), gives no per-gateway
  attribution, and forces a fleet-wide rotation to revoke a single box.
- **mTLS client certificates per gateway.** Rejected for Phase 1: stronger, but far heavier to
  provision and rotate on non-technical, customer-operated venue boxes, and Open Live has no
  existing certificate-issuance machinery. A bearer token reuses the existing auth transport. mTLS
  remains a possible future hardening if a customer's threat model demands it.
- **Short-lived JWTs / OSC PAT→SAT exchange (as Strom auth uses, `config.stromAuthMode`).**
  Rejected for Phase 1: adds a token-exchange dependency and refresh logic on the venue box for no
  Phase-1 benefit; a long-lived, rotatable opaque token is simpler and sufficient for a
  status-only, outbound-only socket. Revisit if Phase 2 control frames raise the risk profile.
- **Store the token in plaintext (or reversibly encrypted) to allow re-display.** Rejected:
  needless exposure. "Shown once + rotate" is the standard, safer pattern and removes any
  at-rest live-token recovery path.
