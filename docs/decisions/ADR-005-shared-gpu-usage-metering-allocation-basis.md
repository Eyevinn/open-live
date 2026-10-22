# ADR-005: Shared-GPU usage is metered on an allocation basis (wall-clock slot time), exposed as closed hourly buckets reusing the CDN metering pattern

**Date**: 2026-10-13
**Status**: Proposed (amended 2026-10-18, see Amendment 1; amended 2026-10-20, see Amendment 2)

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

## Amendment 1: default metering on the platform-hosted shared Strom (2026-10-18)

**Issues**: #526 (parent), #537 (detection + switch, PR #538), #535 (accrual floor, PR #540), #536
(this amendment). The original Decision above is unchanged. This amendment replaces only the
assumption that "the platform sets `GPU_POOL` on managed instances" and the related part of the
`STROM_AUTH_MODE=osc` alternative.

### Context

Nothing on the platform ever set `GPU_POOL`, and no published `eyevinn-open-live` service option
maps to it, so metering never ran on managed instances. The `STROM_AUTH_MODE=osc` premise was also
false: the open-live-site funnel creates managed instances with `StromAuthMode: "direct"`, so auth
mode cannot tell a managed instance from a self-hosted one. Decision (birme, #526): the defaults live
in Open Live itself; the service definition is not changed.

### Decision

1. **Switch constant.** `PLATFORM_DEFAULT_METERING_ENABLED` in `src/lib/gpu-metering-defaults.ts` is
   a code constant (not env, not a service option, not tenant-settable). It ships `false`, so
   merging the mechanism changed nothing on any managed instance. Only the human flip PR in
   Eyevinn/open-live-site#205 step 2a may set it to `true`; that flip starts production-hour
   charging (40 tokens per hour) and zero-balance gating.
2. **Rule.** `resolveGpuMetering` meters an instance with no `GPU_POOL` iff the switch is on AND
   `OSC_HOSTNAME` is non-empty AND `STROM_URL` parses as `https` with no userinfo, its host matches
   the anchored `PLATFORM_STROM_HOST_RE = /^strom-se-sto\d{2}\.osaas\.io$/i`, and its port is in
   `PLATFORM_STROM_PORTS = ['8080']`. Path and trailing slash are ignored. Pool = host label minus
   `strom-` (`se-sto01`), class = `shared`, source `platform-default`. `GPU_POOL`/`GPU_CLASS` env
   override the defaults, and `GPU_POOL` alone still enables metering anywhere (source `env`). There
   is no tenant off switch.
   - `OSC_HOSTNAME` is the OSC-managed signal because it is injected by `osaas-lib-orchestrator`
     (`envVarRefs`, applied after the service options) and no published option maps to it. A
     self-hosted deployment does not have it.
   - The host + port pair is the platform-hosted-Strom signal: it meters exactly the shared Strom
     endpoint the funnel hands to tenants (svensson00, #526, 2026-10-16 12:30 and 14:14).
3. **Only `:8080` is metered.** The alternate Strom on `:8082` is internal and is not metered
   (svensson00, #526, 2026-10-16 14:14, replacing the earlier "meter the alternate Strom like the
   shared one" on open-live-site#198). `:8084` (testbed), no port and `:443` also stay at zero.
4. **Accrual floor.** The first time metering is enabled on an instance, `startGpuUsageSweep`
   persists a `gpu-metering-state` marker (`enabledAt`) in the instance CouchDB, never overwritten
   on later restarts. All accrual starts at `accrualStartMs()` = `max(activatedAt, enabledAt)`, so
   nothing from before enablement is ever reported (no back-charge; svensson00, #526, 2026-10-16
   14:14). If the DB is unavailable the floor is the in-memory sweep start, which can undercharge
   but never back-charges.
5. **One predicate.** `isGpuMeteringEnabled()` stays `Boolean(config.gpuPool)` and drives both the
   meter and the zero-balance start gate, so the gate applies to exactly the metered instances.

### Why a wildcard on the OSC instance domain is refused

A suffix or wildcard match (for example any `*.osaas.io` host, or any host under the Strom service
domain) would also match Strom instances that tenants run themselves: a tenant's `eyevinn-strom`
instance gets a multi-label host under the OSC service domain. That is BYO usage, which must stay at
zero (open-live#500 AC5): with a wildcard, a tenant whose `StromUrl` points at their own Strom
instance would be metered, charged and gated for GPU time the platform does not provide. The regex is anchored to one `strom-se-stoNN` label directly under
`osaas.io`. No tenant-reachable path issues such a name: there is no apex wildcard on `osaas.io`,
My Apps names are multi-label, and `osaas.io` is a reserved zone for tenant custom domains in
osaas-deploy-manager (verified in PR #538). A new `strom-se-stoNN` box on `:8080` meters with no code
change.

### Existing instances

The behaviour lives in the image; nothing is set per instance. After the open-live-site#205 step 2a
flip is released, an existing managed shared-Strom instance meters and is gated from its **next
restart** onto that image, with no forced remake. Instances that do not restart stay unmetered (and
ungated) until they do. BYO and self-hosted deployments are unaffected.

### Consequences and risks

- **Fail to zero.** If the funnel's `STROM_URL` moves to a host or port not covered by
  `PLATFORM_STROM_HOST_RE` / `PLATFORM_STROM_PORTS`, new instances silently stop metering (and are
  not gated). The list must be updated in a released image before the funnel's URL changes.
- **Flip back, then flip on again.** The `enabledAt` marker keeps the first enablement time. A
  production live through an off window would accrue that window on re-enable unless the
  `gpu-metering-state` doc is deleted before the re-enabling restart (PR #540, "Risks not covered").
- Superseded: the "Infer shared GPU from `STROM_AUTH_MODE=osc`" alternative above remains rejected,
  but its premise that the platform turns metering on by setting `GPU_POOL` no longer holds; the
  default rule above replaces it.

## Amendment 2: no switch, platform-hosted charging is unconditional (2026-10-20)

**Issue**: #547 (part of Eyevinn/open-live-site#198; replaces the "one-line flip PR" of
Eyevinn/open-live-site#205 step 2a). This amendment supersedes **Amendment 1 decision 1 only**.
Amendment 1 is not rewritten and its other decisions (rule, `:8080` only, accrual floor, one
predicate) stand, except that decision 2's `GPU_CLASS` override no longer applies on a platform
match (point 2 below).

### Context

Amendment 1 decision 1 added the code constant `PLATFORM_DEFAULT_METERING_ENABLED` (PR #538),
shipped `false`, as a release gate for default metering. Product decision (svensson00, PM decision
authority, 2026-10-20, #547): GPU time on the platform-hosted shared Strom is charged by default for
every OSC-managed Open Live instance, and there is no setting that turns it off. The constant is
history; it no longer exists in the code.

### Decision

1. **No switch.** The constant and the `enabled` input of `resolveGpuMetering` are removed. A
   managed instance (`OSC_HOSTNAME` non-empty) whose `STROM_URL` matches the Amendment 1 rule
   (`https`, no userinfo, host `^strom-se-sto\d{2}\.osaas\.io$`, port in
   `PLATFORM_STROM_PORTS = ['8080']`) is always metered and gated by the zero-balance check from its
   next restart onto the released image. Nothing a tenant or an operator sets on the instance turns
   that off. Everything else stays at zero, as before.
2. **Class forced to `shared` on a platform match.** Whenever `STROM_URL` is a platform match, the
   resolved class is `shared` on both branches of `resolveGpuMetering` (the `platform-default`
   branch and the explicit `GPU_POOL` `env` branch), whatever `GPU_CLASS` says. Otherwise a
   non-`shared` class (only `shared` is metered to tokens) would be a way to stop the charge while
   the meter still runs. Off a platform match, `GPU_CLASS` stays a dashboard label. This narrows the
   override documented in Amendment 1 decision 2 and needs @birme's sign-off in review.
3. **`GPU_POOL` is internal.** It stays operator and test configuration (pool label; enabling
   metering on a non-platform instance for a test). It can only add metering, never remove it, and
   it is not part of any customer-facing text.
4. **Unchanged.** `PLATFORM_STROM_HOST_RE`, `PLATFORM_STROM_PORTS`, `platformStromPool`, the single
   predicate `isGpuMeteringEnabled() = Boolean(config.gpuPool)`, the accrual floor (#535, PR #540),
   the `osc-gpu-usage/v1` schema, the rate (40 tokens per hour, open-live#500), the zero-balance
   gate, and the alternate Strom (`:8082`, not metered).

### Release

Merging #547 to `main` releases to prod through `sync-fork-on-merge.yml`. It is merged by a person
under Eyevinn/open-live-site#205 step 2a, never by automation. Existing managed shared-Strom
instances are charged from their next restart onto the released image, with no forced remake; the
accrual floor is that first restart, so nothing before it is reported and no production is refused
for a zero balance before it.

### Rollback

With no switch, undoing charging means reverting this change, releasing the revert, and restarting
the instances. The `gpu-metering-state` `enabledAt` marker keeps the first enablement time, so a
production that stays live through such an off window would be back-charged for it on re-enable,
unless the instance's `gpu-metering-state` doc is deleted before the re-enabling restart (PR #540,
"Risks not covered"). Whether to automate that is out of scope.
