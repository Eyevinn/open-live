# ADR-005: Shared-GPU usage is metered on an allocation basis (wall-clock slot time), exposed as closed hourly buckets reusing the CDN metering pattern

**Date**: 2026-10-13
**Status**: Proposed

> Proposed at Phase-1 (architect). Awaiting the team-lead gate. The full spec is in
> `docs/specs/shared-gpu-usage-metering.md` (issue #500). Two product-level Open Questions
> (OQ-2: billing policy / rate card) are NOT settled here — they need a human
> (@birme/@svensson00) before the platform-side meter is registered.

## Context

Open Live runs each production as a Strom flow on a GPU-backed Strom; the managed offering bills a
flat "69 EUR/month (shared GPU in Frankfurt)" (`README.md:14`) regardless of consumption, and there
is **no** surface reporting GPU time (`src/routes/health.ts` exposes only `/health`/`/healthz`/`/ready`;
no `prom-client` in `package.json`; no usage endpoint). Issue #500 asks open-live to expose GPU usage
for Prometheus and for OSC token billing, and to propose a cross-service `osc-gpu-usage/v1` standard.

The two choices this ADR settles affect more than one service (open-live + the OSC metering platform)
and make a long-term trade-off, so per `epic-workflow.md` §ADR they are recorded here:

1. **What "GPU time" means for v1** — allocation (slot held) vs. utilisation (actual NVENC/NVDEC/SM load).
2. **How usage is exposed and converted to money** — a bespoke path vs. reusing the CDN metering pattern.

Constraints grounded in the code:

- Open Live already observes flow lifecycle: `stromFlowId` is set on activate
  (`src/routes/productions.ts:390`), status goes `active` at `productions.ts:533,554`, every flow is
  tagged `properties.description = "prod:<id>"`, and startup `reconcileProductionStatuses`
  (`src/services/reconcile.ts`) cross-references stored flow ids against `strom.flows.list()`.
- **There is no activation timestamp on `ProductionDoc`** (`createdAt`/`updatedAt`/`airTime` only),
  so "resume from recorded start" is impossible without an additive field.
- **Strom exposes no per-pipeline GPU usage.** `FlowStatsResponse.stats` is
  `Record<string, unknown>` (`src/lib/strom.ts:470`) — unstructured, no NVENC/NVDEC/SM field.
- **Open Live has no tenant/workspace/instance id** in config (`OSC_SAT_SERVICE_ID` is a *service*
  id, `src/config.ts:174`); tenant is known only at the platform edge.
- CDN acceleration already proves the metering pattern
  ([agent-team-osc-dev ADR-0057](https://github.com/Eyevinn/agent-team-osc-dev/blob/main/adr/0057-per-endpoint-cdn-acceleration-metered-to-tokens.md)):
  a service-side counter, an hourly settle into immutable buckets, idempotent per-hour events to
  money-manager's generic engine (`POST /meters/:meterId/events`), a 7-day `occurredAt` dead-letter.

## Decision

1. **v1 meters GPU time on an allocation basis: wall-clock seconds a production's Strom flow holds a
   slot on the shared GPU** — the interval `[flow reached 'playing', flow stopped]`. It is derived
   entirely from the lifecycle open-live already tracks; it needs **no NVML/DCGM and no new Strom
   API**, cannot be gamed by a tenant, and is easy to explain on an invoice. The response carries an
   explicit `basis: "allocation"` field so a later `"utilisation"` basis is a non-breaking addition,
   not a schema break.

2. **Usage is exposed and billed exactly like CDN.** Accrual is persisted as **append-only, immutable
   closed UTC-hour buckets** and exposed over a **bearer-authed** `GET /api/v1/usage/gpu` (schema
   `osc-gpu-usage/v1`) plus a bearer-authed `GET /metrics` for dashboards. The platform reads the JSON
   buckets and converts them to idempotent per-hour meter events — no second billing path is built.
   **Billing reads the JSON buckets, never the Prometheus counter** (a counter loses information on
   restart; `rate()` windows are approximate).

3. **Accrual is persisted so it survives restart and settles the final partial hour.** Add two
   additive `ProductionDoc` fields: `activatedAt` (set in the same write as `status: 'active'`) and
   `gpuHours` (append-only closed-hour buckets). A periodic settle sweep writes each hour once; every
   teardown path runs a final settle; reconcile preserves `activatedAt` on the restore branch so a
   production whose flow is still live after a restart resumes accruing from its recorded start, not
   from zero.

4. **The `osc-gpu-usage/v1` surface is proposed as a cross-service OSC standard** (two Prometheus
   series + the JSON endpoint + the attribution/immutability rules), so other GPU-consuming OSC
   services implement one contract and the platform integrates once. open-live is its first implementor.

## Consequences

**Positive**:
- Cheap and robust: accrual uses only data open-live already has; the only persisted writes are once
  per closed hour per production, append-only, so restarts/concurrent sweeps cannot double-count.
- No new hard dependency: allocation needs no NVML and no new Strom API; `/metrics` can be
  hand-rendered (two families) without `prom-client`.
- Reuses a proven billing pattern (CDN): idempotent per-hour events + dead-letter, one platform
  integration for all future GPU services via the standard.
- Future-proof: the `basis` field lets utilisation metering land later without breaking consumers.

**Negative**:
- Allocation charges for an idle-but-running pipeline (a tenant that leaves a production active but
  unused still accrues). Fairness is a product call (spec OQ-2), not fixed by this ADR.
- Adds two fields to `ProductionDoc` and a settle sweep service — more moving parts than "none".
- The Prometheus counter is not a billing-grade source (by design); consumers must not read it for money.

**Risks**:
- **`/metrics` served unauthenticated** if only kept out of `AUTH_EXEMPT_PATHS`: the shared-key hook
  only guards `/api/v1`/`/ws/`/`/documentation` prefixes (`src/server.ts:400-406`), so a top-level
  `/metrics` bypasses auth unless the prefix check is extended. *Detection:* a test asserting
  `GET /metrics` → 401 without a token (spec §2.1, §9).
- **Lost partial hour on a hard crash** between settle sweeps (bounded by `GPU_SETTLE_INTERVAL_MS`;
  the exact death time is unobservable from open-live — spec OQ-1).
- **Unattributed buckets** until the platform resolves instance→tenant (open-live has no tenant id
  today); mitigated by never dropping a bucket and emitting `"unattributed"`.

## Alternatives Considered

- **Utilisation basis (NVENC/NVDEC/SM load via NVML/DCGM).** *Rejected for v1.* Fairer, but Strom
  exposes no per-pipeline GPU stats today (`FlowStatsResponse.stats` is untyped, `strom.ts:470`), it
  needs NVML access open-live does not have, and it is harder to dispute on an invoice. The `basis`
  field leaves the door open to add it later without a breaking change.
- **Bill directly from the Prometheus counter (`rate()`/`increase()`).** *Rejected.* A counter resets
  on restart and `rate()` windows are approximate — unacceptable for money. Prometheus stays for
  dashboards/alerting; the immutable JSON buckets are the billing source of truth.
- **A bespoke GPU billing path separate from CDN.** *Rejected.* It would duplicate the settle/idempotency/
  dead-letter machinery the generic metering engine already provides and force a new per-service
  platform integration. Reusing the CDN pattern + a shared standard is strictly less new code.
- **A high-frequency (per-second/per-minute) persisted counter.** *Rejected.* It turns accrual into a
  read-modify-write hot path with restart/concurrency races. Append-only closed-hour buckets + a
  derived current hour from `activatedAt` make every persisted write idempotent and once-per-hour.
- **Infer "shared GPU" from `STROM_AUTH_MODE=osc`.** *Rejected as the gate.* Too implicit; an explicit
  `GPU_POOL` opt-in (metering off unless set) keeps self-hosted/BYO instances reporting zero with no
  guesswork, and lets the platform turn metering on only where it provisions the shared GPU.
