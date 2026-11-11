# ADR-014: SRT directions are read from Strom's reported capabilities, refused only on a definite answer

**Date**: 2026-11-11
**Status**: Proposed

> For Eyevinn/open-live#628. Full contract in `docs/specs/srt-direction-capabilities.md`.
> Depends on Eyevinn/strom#1257 (open, not yet implemented) and builds on the draft
> Eyevinn/open-live#629 (SRT relay status cache).

## Context

The studio offers Listener, Caller and (with #629) Via relay for every SRT source and output,
whatever Strom can actually do. On Strom in Kubernetes or behind Docker NAT, a listener port is not
reachable from outside, so Listener yields an address nobody can dial and nothing explains why.

Whether a direction works depends on how Strom is deployed. strom#1257 proposes that Strom be told
(`STROM_INBOUND_REACHABLE`, `STROM_PORTS`, `STROM_SRT_RELAY`) and report the result over an API.
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
   on `GET /api/srt-relay` if strom#1257 picks that option).
2. **One cached poller.** #629's relay-status cache is generalised to fetch relay status and
   capabilities in the same refresh, with the same timings, one cache entry, and a separate state
   for each half.
3. **Additive `server-info.srt { listener, caller, relay, ports, state }`.** Existing fields
   (`srtPorts`, `srtPortState`, `srtRelay`) stay.
4. **Refuse only on a definite answer.** Create, or a PATCH that changes the direction, to a
   direction Strom positively reports as unsupported gets **422**
   `{ error, statusCode, code: "srt-direction-unsupported", direction }`. Unreachable or unknown
   Strom: accept, and say so on a new optional `connect.warning`. Older Strom (404): offer and
   accept everything, no warning.
5. **Existing records are never filtered and never blocked at activation.** Only new choices are
   restricted.
6. **Listener ports outside Strom's `ports`: warn, not refuse**, except where the legacy port
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
visible immediately in `server-info.srt` and the 422 message, which names the setting's effect.

## Alternatives Considered

- **Open Live env var (e.g. `SRT_LISTENER_ENABLED`).** Rejected: duplicates a fact about Strom's
  deployment in a second place that drifts, and does not help other Strom clients.
- **Detect reachability at runtime (probe a listener port from outside).** Rejected: NAT, firewalls
  and load balancers make it unreliable, as strom#1257 notes.
- **Use the port broker / reservation result as the signal.** Rejected: legacy, planned for removal,
  and "no ports reserved" does not mean "not reachable".
- **Hide only in the UI, no API refusal.** Rejected: the API would accept addresses the UI says do
  not work, so gateways and Companion would still create undialable listeners.
- **Refuse whenever Strom is not known to support the direction (including unreachable).** Rejected:
  a slow or restarting Strom would block every listener write; #629 already set the precedent of
  refusing only on a definite answer.
- **A separate poller per endpoint.** Rejected: two caches with different staleness can disagree in
  one `server-info` response; one refresh cycle is simpler.
