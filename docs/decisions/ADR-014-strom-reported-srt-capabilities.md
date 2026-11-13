# ADR-014: SRT directions are read from Strom's reported capabilities; modes are reported, only relays are refused on a definite answer

**Date**: 2026-11-11
**Status**: Accepted (amended 2026-11-13)

> For Eyevinn/open-live#628. Full contract in `docs/specs/srt-direction-capabilities.md`.
> Upstream: Strom >= 0.8.2 (Eyevinn/strom#1260 `GET /api/capabilities` and #1262 named SRT
> relays, both merged). Implemented in Eyevinn/open-live#629 and Eyevinn/open-live-studio#259.

> **Amended 2026-11-13 (#629).** Strom shipped `GET /api/capabilities` with SRT `modes` and named
> `relays` and dropped `GET /api/srt-relay`, so Decision 2 is one poller over one endpoint.
> Decision 3's shape became `server-info.srt { state, modes, relays, inboundReachable, ports }`
> (replacing the unreleased `srtRelay`). Decision 4 was reversed for modes: Open Live **reports**
> an unsupported mode (`connect.warning`) and never refuses it; only a relay Strom definitely
> does not have is refused (422, `code: srt-relay-not-configured | srt-relay-unknown`). The
> reasons are recorded under the "Hide only in the UI" alternative below. Signed off by the
> team-lead on [#629](https://github.com/Eyevinn/open-live/pull/629#issuecomment-6859992148);
> see the amendment decisions in the spec.

## Context

The studio offers Listener, Caller and (with #629) Via relay for every SRT source and output,
whatever Strom can actually do. On Strom in Kubernetes or behind Docker NAT, a listener port is not
reachable from outside, so Listener yields an address nobody can dial and nothing explains why.

Whether a direction works depends on how Strom is deployed. strom#1257 proposes that Strom be told
(`STROM_INBOUND_REACHABLE`, `STROM_PORTS`, `STROM_SRT_RELAY_PUBLIC` / `STROM_SRT_RELAYS`) and report the result over an API.
Open Live already reads the SRT relay from Strom (#629: `GET /api/srt-relay`, a cached
stale-while-revalidate poller, 422 when Strom positively reports no relay).

Constraints: `server-info` and the source/output API are consumed by the studio, gateways and
Companion, so changes must be additive; a request must never wait on Strom; Strom builds without the
endpoint must keep today's behaviour; the legacy port broker / reservation flow is being retired and
must not become the signal.

This changes the cross-service contract (Strom → open-live → studio), so it needs an ADR.

## Decision

1. **Strom is the source of truth.** Open Live adds no env var for SRT reachability. It reads
   Strom's capabilities (proposed `GET /api/capabilities`; the parser also accepts the same fields
   on `GET /api/srt-relay` if strom#1257 picks that option). *(Amended 2026-11-13: Strom shipped
   `GET /api/capabilities` and removed `GET /api/srt-relay`, which Open Live no longer reads.)*
2. **One cached poller.** #629's relay-status cache is generalised to fetch relay status and
   capabilities in the same refresh, with the same timings, one cache entry, and a separate state
   for each half. *(Amended 2026-11-13: one cache, `src/services/strom-capabilities.ts`, over one
   fetch of `GET /api/capabilities`, with one `state`; same timings.)*
3. **Additive `server-info.srt`.** *(Amended 2026-11-13.)* Shipped as `server-info.srt { state,
   modes: { listener, caller, rendezvous }, relays: [{ name, public }], inboundReachable, ports }`
   (originally `{ listener, caller, relay, ports, state }`). `srtPorts` and `srtPortState` stay;
   `srtRelay` was removed before release (it never shipped).
4. **Modes are reported; only relays are refused, and only on a definite answer.** *(Amended
   2026-11-13.)*
   - **Modes** (listener, rendezvous): a create or PATCH to a mode Strom reports as unsupported
     is accepted (201/200) and flagged on a new optional `connect.warning`
     (`srt-listener-unsupported`, `srt-rendezvous-unsupported`), on the write response and on
     every read. While Strom is unreachable the warning uses the last-known modes. Older Strom
     (404): every mode, no warning. No `srt-direction-unsupported` 422 and no
     `srt-capabilities-unknown` warning.
   - **Relays**: an `srt+relay://` address naming a relay Strom definitely does not have
     (`state` `ok` or `unsupported`) gets **422** `{ error, statusCode, code, relays }` with
     `code: srt-relay-not-configured` (no relay at all) or `srt-relay-unknown` (none of that
     name; `relays` lists the names). No `direction` field: a relay address always means the
     relay direction. Unreachable or unknown Strom: accepted, with
     `connect.reason: srt-relay-unreachable`.
   - The mode of a plain `srt://` address is read as GStreamer runs it: hostless is a listener
     whatever `mode` says (so hostless `mode=caller` is a listener, not "no direction"); with a
     host, `mode` (default caller).
5. **Existing records are never filtered and never blocked at activation.** Only new choices are
   restricted.
6. **Listener ports outside Strom's `ports`: warn, not refuse** (`connect.warning:
   srt-port-outside-strom-ports`; an unsupported Listener wins), except where the legacy port
   reservation already refuses today.

## Consequences

**Positive**: The UI and the API agree on what works, from the one component that knows. No
duplicated deployment config in Open Live. Zero behaviour change against current Strom builds, so
the Open Live side can ship before strom#1257. No extra polling load (one refresh cycle).

**Negative**: A second Strom request per refresh. A new optional field on `connect` (`warning`) that
clients must learn to show. A brief window (≤30 s cache) where a write can be refused or accepted
against stale capabilities. Two port lists coexist (`srtPorts` from the reservation, `srt.ports`
from capabilities) until the reservation flow is removed.

**Risks**: strom#1257 lands with a different shape → contained in the parser, detectable by a
contract test against a stubbed Strom. #629 changes before merging → this design follows its cache
and resolver. A misconfigured `STROM_INBOUND_REACHABLE=false` on a reachable Strom hides Listener →
visible immediately in `server-info.srt` and on `connect.warning`.

## Alternatives Considered

- **Open Live env var (e.g. `SRT_LISTENER_ENABLED`).** Rejected: duplicates a fact about Strom's
  deployment in a second place that drifts, and does not help other Strom clients.
- **Detect reachability at runtime (probe a listener port from outside).** Rejected: NAT, firewalls
  and load balancers make it unreliable, as strom#1257 notes.
- **Use the port broker / reservation result as the signal.** Rejected: legacy, planned for removal,
  and "no ports reserved" does not mean "not reachable".
- **Hide only in the UI, no API refusal.** *Originally rejected* ("the API would accept addresses
  the UI says do not work, so gateways and Companion would still create undialable listeners").
  **Adopted for modes on 2026-11-13** (team-lead sign-off on #629), because:
  - `STROM_INBOUND_REACHABLE` is one yes/no setting for the whole deployment: a hint, not proof.
    It knows nothing about the NodePort/hostPort/load-balancer forwards operators set up outside
    Strom, so a listener it calls unreachable may well be dialable.
  - Refusing would break open-live-ingest's default registration: in its default `caller`
    uplink it registers `srt://:<port>?mode=listener` on the cloud Open Live, which needs only
    that one forwarded port. A 422 would fail it outright on the strength of the hint.
  - Companion writes no SRT addresses, so it cannot create undialable listeners.
  - The clients that do write addresses see the problem: the 201/200 of every create and PATCH
    carries `connect.warning`. Follow-up Eyevinn/open-live-ingest#23 surfaces it in the gateway.

  Dropped with it: the `srt-capabilities-unknown` warning (with nothing gated it means nothing,
  and it would mark every SRT record whenever Strom is briefly down; `server-info.srt.state`
  carries the state). Changed with it: hostless `mode=caller` maps to listener rather than to no
  direction, since GStreamer runs it as one and mapping it away would hide the warning on exactly
  the address that needs it. Relays keep a refusal: a relay Strom does not have can never work,
  and the answer is definite.
- **Refuse whenever Strom is not known to support the direction (including unreachable).** Rejected:
  a slow or restarting Strom would block every listener write; #629 already set the precedent of
  refusing only on a definite answer.
- **A separate poller per endpoint.** Rejected: two caches with different staleness can disagree in
  one `server-info` response; one refresh cycle is simpler.
