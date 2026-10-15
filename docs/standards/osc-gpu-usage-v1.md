# OSC shared-GPU usage standard — `osc-gpu-usage/v1`

**Status:** Proposed (first implementor: Eyevinn/open-live, issue #500).
**Related:** ADR-005, `docs/specs/shared-gpu-usage-metering.md`. Billing reuses the
OSC generic-metering pattern established for CDN acceleration.

This is a **cross-service contract**, not open-live documentation. Any OSC service
that consumes shared GPU exposes the two surfaces below so the OSC platform
integrates **once** and meters every such service the same way. It is written so a
service author can implement it without reading open-live's source.

## 1. Surfaces

A conforming service exposes, both **bearer-authenticated, never anonymous**:

| Surface | Path | Purpose |
|---|---|---|
| JSON usage endpoint | `GET /api/v1/usage/gpu` | Billing — closed UTC-hour buckets. The source of truth for money. |
| Prometheus metrics | `GET /metrics` | Dashboards / alerting only. |

A service that does not currently consume shared GPU (self-hosted, BYO hardware,
feature disabled) still serves both surfaces, reporting **zero**: `hours: []` and
no `osc_gpu_*` samples. A bucket is never fabricated and never dropped.

## 2. `GET /api/v1/usage/gpu`

### Request

```
GET /api/v1/usage/gpu[?since=<ISO-8601 instant>]
Authorization: Bearer <token>
```

- `since` (optional cursor): return only buckets whose `hour` is **strictly
  after** this instant. Malformed value → `400`.

### Response — `200 application/json`

```json
{
  "standard": "osc-gpu-usage/v1",
  "service": "eyevinn-open-live",
  "basis": "allocation",
  "generatedAt": "2026-10-13T14:07:12Z",
  "settledThrough": "2026-10-13T14:00:00Z",
  "hours": [
    {
      "hour": "2026-10-13T13:00:00Z",
      "tenantId": "unattributed",
      "resource": "production-17",
      "gpuPool": "fra-1",
      "gpuClass": "shared",
      "seconds": 3180
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `standard` | const string | `"osc-gpu-usage/v1"`. |
| `service` | string | Reporting service id. |
| `basis` | `"allocation"` \| `"utilisation"` | How GPU time is measured. v1 services emit `"allocation"`. Stated explicitly so a later utilisation basis is a non-breaking addition. |
| `generatedAt` | ISO 8601 UTC | When the response was produced. The ONLY non-immutable timestamp. |
| `settledThrough` | ISO 8601 UTC, top of hour | Buckets with `hour < settledThrough` are **immutable**. Always the start of the current UTC hour; the current partial hour is never emitted as a closed bucket. |
| `hours[]` | array | One entry per (closed hour × resource). Empty array is valid. |
| `hours[].hour` | ISO 8601 UTC, top of hour | Bucket start. `hour + 1h ≤ settledThrough`. |
| `hours[].tenantId` | string | OSC workspace id if the service can resolve it, else `"unattributed"` — **never dropped** (§5). |
| `hours[].resource` | string | Stable per billable unit within the service (e.g. a production, a job). |
| `hours[].gpuPool` | string | GPU pool label (e.g. `fra-1`). |
| `hours[].gpuClass` | string | GPU class; `"shared"` is the metered class. |
| `hours[].seconds` | integer, `0..3600` | GPU-seconds accrued in that hour for that resource. |

### Errors

`400` (malformed `since`), `401` (missing/invalid bearer), `503` (backing store
unavailable). No `404`.

## 3. `GET /metrics`

Prometheus text exposition (`text/plain; version=0.0.4`). Exactly two families:

```
# HELP osc_gpu_seconds_total Shared GPU time consumed, in seconds.
# TYPE osc_gpu_seconds_total counter
osc_gpu_seconds_total{tenant="acme",resource="production-17",gpu_pool="fra-1",gpu_class="shared"} 5421
# HELP osc_gpu_active Number of GPU-consuming workloads running right now.
# TYPE osc_gpu_active gauge
osc_gpu_active{tenant="acme",gpu_pool="fra-1"} 1
```

- `osc_gpu_seconds_total{tenant, resource, gpu_pool, gpu_class}` — monotonic
  counter of cumulative GPU-seconds.
- `osc_gpu_active{tenant, gpu_pool}` — gauge of workloads running now (`0` when
  idle).
- `tenant` carries the same value as JSON `tenantId` (`"unattributed"` when
  unresolved).
- Empty families still emit their HELP/TYPE header lines with no samples.

**Prometheus is for observability, not billing.** A counter loses information on
process restart and `rate()` windows are approximate, so **billing reads the JSON
hour buckets**, never this counter.

## 4. Measurement basis

- **`allocation` (v1):** wall-clock seconds a workload holds a slot on a
  shared-GPU runtime. Cheap, un-gameable, needs no NVML/DCGM. v1 of this standard.
- **`utilisation` (reserved):** weighting by actual NVENC/NVDEC/SM load. Not
  defined by v1; the `basis` field reserves room for it without a schema break.

## 5. Attribution

`tenantId` is the OSC workspace id. A service that cannot resolve it internally
emits `"unattributed"` and the **platform poller resolves instance→tenant** (it
knows which instance it polled) and overrides the value. A bucket without a
resolvable tenant is **reported under `"unattributed"`, never dropped**.

## 6. Granularity & immutability

Usage is reported in **closed UTC-hour buckets**. A bucket is immutable once
`settledThrough` has passed its `hour`. The current (partial) hour is never
emitted as a closed bucket. This lets the platform poll idempotently without
depending on a counter surviving across restarts, and survives restarts and
abnormal workload termination (the final partial hour is settled, not lost).

## 7. Platform side (informative — separate tickets, not part of a service's work)

The OSC platform registers a `gpu-time` meter (`unitLabel: "hour"`, dimensioned by
`gpuClass`) with a rate card in tokens per GPU-hour; a poller reads each opted-in
instance's `/api/v1/usage/gpu`, resolves instance→tenant, and posts one idempotent
per-hour event per bucket:

```json
{
  "tenantId": "acme",
  "idempotencyKey": "gpu:<instanceId>:<YYYYMMDDHH>",
  "occurredAt": "2026-10-13T13:00:00Z",
  "dimensions": { "gpuClass": "shared" },
  "quantities": { "hours": 0.883 }
}
```

The idempotency key makes re-polling safe; a dead-letter path handles hours still
unreported inside the engine's `occurredAt` window. Meter registration, the rate
card, the poller and token conversion are **out of scope** for a service
implementing this standard — the service only exposes the two surfaces above.
