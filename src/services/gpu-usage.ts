/**
 * Shared-GPU usage metering (issue #500, `docs/specs/shared-gpu-usage-metering.md`,
 * ADR-005; the cross-service contract is `docs/standards/osc-gpu-usage-v1.md`).
 *
 * v1 meters GPU time on an **allocation basis**: the wall-clock seconds during
 * which a production's Strom flow holds a slot on the shared GPU — the interval
 * `[flow reached 'playing' (ProductionDoc.activatedAt), flow stopped]`. It needs
 * only the lifecycle open-live already observes (no NVML, no new Strom API).
 *
 * Accrual is persisted as append-only, immutable **closed UTC-hour buckets**
 * (`ProductionDoc.gpuHours`). A periodic settle sweep writes each hour exactly
 * once as it fully elapses; every stop path settles the final partial hour; the
 * current partial hour of a live production is derived on read from
 * `activatedAt`, never stored, so there are no read-modify-write races.
 *
 * Billing reads the JSON hour buckets (`/api/v1/usage/gpu`), NOT the Prometheus
 * counter (`/metrics`), which loses information on restart (ADR-005 §Decision 3).
 */

import type { FastifyBaseLogger } from 'fastify';
import { config, isGpuMeteringEnabled } from '../config.js';
import { getDb, isDbConnected } from '../db/index.js';
import type { ProductionDoc } from '../db/types.js';

const HOUR_MS = 3_600_000;

/** Schema id emitted in the `standard` field of the JSON usage response. */
export const GPU_USAGE_STANDARD = 'osc-gpu-usage/v1';

/** v1 metric basis (ADR-005). The field exists so a future `utilisation` basis
 *  is a non-breaking addition. */
export const GPU_USAGE_BASIS = 'allocation' as const;

/** Floor a ms timestamp to the start of its UTC hour. */
export function startOfUtcHour(ms: number): number {
  return ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);
}

/** ISO 8601 UTC hour key `"YYYY-MM-DDTHH:00:00Z"` for a ms timestamp. */
export function isoHour(ms: number): string {
  return new Date(startOfUtcHour(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** ISO 8601 UTC with second precision (no milliseconds) for `generatedAt`. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * GPU-second buckets per UTC hour for the interval `[activatedAtMs, endMs]`,
 * skipping any hour key already present in `existing` (append-only / idempotent).
 * Each value is clamped to `0..3600`. Hours with zero overlap are omitted.
 *
 * The caller picks `endMs`:
 *   - a running production, settling only fully-closed hours → `startOfUtcHour(now)`
 *     (the current partial hour is excluded);
 *   - a stopped production, final settle → the stop time (the final partial hour
 *     is included).
 */
export function computeHourBuckets(
  activatedAtMs: number,
  endMs: number,
  existing: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Number.isFinite(activatedAtMs) || !Number.isFinite(endMs) || endMs <= activatedAtMs) {
    return out;
  }
  for (let hStart = startOfUtcHour(activatedAtMs); hStart < endMs; hStart += HOUR_MS) {
    const key = isoHour(hStart);
    if (key in existing) continue;
    const hEnd = hStart + HOUR_MS;
    const overlapMs = Math.min(endMs, hEnd) - Math.max(activatedAtMs, hStart);
    const seconds = Math.max(0, Math.min(3600, Math.round(overlapMs / 1000)));
    if (seconds > 0) out[key] = seconds;
  }
  return out;
}

/** Drop closed-hour buckets older than the configured retention window. */
export function pruneExpiredHours(hours: Record<string, number>, nowMs: number): Record<string, number> {
  const cutoff = nowMs - config.gpuUsageRetentionHours * HOUR_MS;
  const out: Record<string, number> = {};
  for (const [key, seconds] of Object.entries(hours)) {
    const t = Date.parse(key);
    if (Number.isFinite(t) && t >= cutoff) out[key] = seconds;
  }
  return out;
}

/**
 * Compute the `gpuHours` map to persist when a production STOPS (deactivate,
 * idle auto-deactivate, activation failure). Settles every hour up to `nowMs`
 * INCLUDING the final partial hour, merges it onto the existing buckets and
 * prunes expired ones. Returns `undefined` — i.e. "leave `gpuHours` unchanged" —
 * when metering is disabled, the production never accrued, or nothing is left to
 * write, so callers only persist a `gpuHours` field when there is one.
 *
 * Pure (takes a plain doc slice + clock) so every synchronous stop path can call
 * it inline. The current partial hour becomes immutable here because the
 * production has stopped and will accrue no more into it.
 */
export function settleOnStop(
  doc: Pick<ProductionDoc, 'activatedAt' | 'gpuHours'>,
  nowMs: number = Date.now(),
): Record<string, number> | undefined {
  if (!isGpuMeteringEnabled() || !doc.activatedAt) return undefined;
  const activatedAtMs = Date.parse(doc.activatedAt);
  if (!Number.isFinite(activatedAtMs)) return undefined;
  const existing = doc.gpuHours ?? {};
  const fresh = computeHourBuckets(activatedAtMs, nowMs, existing);
  const merged = pruneExpiredHours({ ...existing, ...fresh }, nowMs);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// ---------------------------------------------------------------------------
// Settle sweep — periodic persistence of fully-elapsed hours for live productions
// ---------------------------------------------------------------------------

function isConflict(err: unknown): boolean {
  return err instanceof Error && 'statusCode' in err && (err as { statusCode?: number }).statusCode === 409;
}

/**
 * Settle one live production's fully-elapsed hours (append-only) and prune
 * expired buckets, with retry-on-409. Re-reads the doc so concurrent writes
 * (the WS layer, a deactivate) cannot be clobbered. A no-op when the production
 * is no longer active or has no recorded start.
 */
async function settleOneProduction(productionId: string, nowMs: number, log: FastifyBaseLogger): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let doc: ProductionDoc;
    try {
      doc = await getDb().get(productionId);
    } catch (err) {
      log.warn({ err, productionId }, '[gpu-usage] could not read production to settle');
      return;
    }
    if (doc.status !== 'active' || !doc.activatedAt) return;
    const activatedAtMs = Date.parse(doc.activatedAt);
    if (!Number.isFinite(activatedAtMs)) return;

    const existing = doc.gpuHours ?? {};
    // Only fully-closed hours — the current partial hour stays derived from
    // activatedAt and is never persisted for a live production.
    const fresh = computeHourBuckets(activatedAtMs, startOfUtcHour(nowMs), existing);
    const prunedExisting = pruneExpiredHours(existing, nowMs);
    const hasFresh = Object.keys(fresh).length > 0;
    const prunedAway = Object.keys(prunedExisting).length !== Object.keys(existing).length;
    if (!hasFresh && !prunedAway) return;

    try {
      await getDb().insert({
        ...doc,
        gpuHours: { ...prunedExisting, ...fresh },
        updatedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      if (isConflict(err) && attempt < 2) continue;
      log.warn({ err, productionId }, '[gpu-usage] settle write failed');
      return;
    }
  }
}

/**
 * Settle every currently-active production. Reads the live set with a literal
 * selector (`findTrusted`, no request data — #257). Best-effort: metering off or
 * DB down is a no-op.
 */
export async function settleActiveProductions(log: FastifyBaseLogger, nowMs: number = Date.now()): Promise<void> {
  if (!isGpuMeteringEnabled() || !isDbConnected()) return;
  let result: Awaited<ReturnType<ReturnType<typeof getDb>['findTrusted']>>;
  try {
    result = await getDb().findTrusted({ selector: { type: 'production', status: 'active' }, fields: ['_id'] });
  } catch (err) {
    log.warn({ err }, '[gpu-usage] settle sweep query failed');
    return;
  }
  const docs = Array.isArray(result?.docs) ? (result.docs as { _id: string }[]) : [];
  for (const doc of docs) {
    await settleOneProduction(doc._id, nowMs, log);
  }
}

let sweepInterval: NodeJS.Timeout | null = null;

/** Start the periodic settle sweep. No-op (logged) when metering is disabled. */
export function startGpuUsageSweep(log: FastifyBaseLogger): void {
  if (sweepInterval !== null) return;
  if (!isGpuMeteringEnabled()) {
    log.info('[gpu-usage] Shared-GPU metering disabled (GPU_POOL unset) — settle sweep not started');
    return;
  }
  log.info(
    `[gpu-usage] Shared-GPU metering enabled (pool: ${config.gpuPool}, class: ${config.gpuClass}, settle: ${config.gpuSettleIntervalMs / 1000}s)`,
  );
  sweepInterval = setInterval(() => {
    settleActiveProductions(log).catch((err) => log.error({ err }, '[gpu-usage] Settle sweep error'));
  }, config.gpuSettleIntervalMs);
  // Never keep the process alive for the sweep.
  sweepInterval.unref();
}

/** Stop the sweep. Idempotent; exported for graceful shutdown and tests. */
export function stopGpuUsageSweep(): void {
  if (sweepInterval !== null) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}

export function isGpuUsageSweepRunning(): boolean {
  return sweepInterval !== null;
}

// ---------------------------------------------------------------------------
// Read surfaces — JSON buckets (billing) and Prometheus text (dashboards)
// ---------------------------------------------------------------------------

export interface GpuHourBucket {
  hour: string;
  tenantId: string;
  resource: string;
  gpuPool: string;
  gpuClass: string;
  seconds: number;
}

export interface GpuUsageResponse {
  standard: string;
  service: string;
  basis: typeof GPU_USAGE_BASIS;
  generatedAt: string;
  settledThrough: string;
  hours: GpuHourBucket[];
}

function tenantLabel(): string {
  return config.oscWorkspaceId ?? 'unattributed';
}

function resourceId(productionId: string): string {
  return `production-${productionId}`;
}

/**
 * Combined view of a production's GPU-seconds per hour: persisted closed buckets
 * plus, for a live production, the already-elapsed closed hours of the current
 * life derived from `activatedAt` (so a reader does not have to wait for the next
 * settle sweep). When `includeCurrentPartialHour` is true the still-running hour
 * is included too — used only by the Prometheus counter, never by the immutable
 * JSON buckets.
 */
function hoursForProduction(doc: ProductionDoc, nowMs: number, includeCurrentPartialHour: boolean): Record<string, number> {
  const existing = doc.gpuHours ?? {};
  const all: Record<string, number> = { ...existing };
  if (doc.status === 'active' && doc.activatedAt) {
    const activatedAtMs = Date.parse(doc.activatedAt);
    if (Number.isFinite(activatedAtMs)) {
      const endMs = includeCurrentPartialHour ? nowMs : startOfUtcHour(nowMs);
      for (const [key, seconds] of Object.entries(computeHourBuckets(activatedAtMs, endMs, existing))) {
        all[key] = seconds;
      }
    }
  }
  return all;
}

async function loadProductions(log: FastifyBaseLogger): Promise<ProductionDoc[]> {
  try {
    const result = await getDb().findTrusted({ selector: { type: 'production' } });
    return Array.isArray(result?.docs) ? (result.docs as ProductionDoc[]) : [];
  } catch (err) {
    log.warn({ err }, '[gpu-usage] production query failed');
    return [];
  }
}

/**
 * Build the `osc-gpu-usage/v1` JSON response: closed UTC-hour buckets per
 * (hour × production). `sinceMs`, when set, keeps only buckets strictly after
 * the cursor. Returns an empty `hours` array when metering is disabled or the DB
 * is unavailable (so a self-hosted / BYO instance reports zero shared-GPU time).
 */
export async function buildGpuUsageResponse(
  opts: { sinceMs?: number },
  log: FastifyBaseLogger,
  nowMs: number = Date.now(),
): Promise<GpuUsageResponse> {
  const settledThroughMs = startOfUtcHour(nowMs);
  const base = {
    standard: GPU_USAGE_STANDARD,
    service: config.oscSatServiceId,
    basis: GPU_USAGE_BASIS,
    generatedAt: isoSeconds(nowMs),
    settledThrough: isoHour(nowMs),
  };
  if (!isGpuMeteringEnabled() || !isDbConnected()) {
    return { ...base, hours: [] };
  }

  const pool = config.gpuPool!;
  const cls = config.gpuClass;
  const tenantId = tenantLabel();
  const hours: GpuHourBucket[] = [];

  for (const doc of await loadProductions(log)) {
    const resource = resourceId(doc._id);
    for (const [hour, seconds] of Object.entries(hoursForProduction(doc, nowMs, false))) {
      const hourMs = Date.parse(hour);
      if (!Number.isFinite(hourMs)) continue;
      // Only closed (immutable) hours, and only after the optional cursor.
      if (hourMs >= settledThroughMs) continue;
      if (opts.sinceMs !== undefined && hourMs <= opts.sinceMs) continue;
      hours.push({ hour, tenantId, resource, gpuPool: pool, gpuClass: cls, seconds });
    }
  }

  hours.sort((a, b) => (a.hour === b.hour ? a.resource.localeCompare(b.resource) : a.hour.localeCompare(b.hour)));
  return { ...base, hours };
}

/** Escape a Prometheus label value (backslash, double-quote, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render the two required Prometheus families (`osc_gpu_seconds_total` counter,
 * `osc_gpu_active` gauge) in text exposition format. Empty families still emit
 * their HELP/TYPE header lines with no samples (valid Prometheus). When metering
 * is disabled or the DB is down, only the headers are emitted.
 */
export async function buildPrometheusMetrics(log: FastifyBaseLogger, nowMs: number = Date.now()): Promise<string> {
  const counterSamples: string[] = [];
  const gaugeSamples: string[] = [];

  if (isGpuMeteringEnabled() && isDbConnected()) {
    const pool = escapeLabel(config.gpuPool!);
    const cls = escapeLabel(config.gpuClass);
    const tenant = escapeLabel(tenantLabel());
    let activeCount = 0;

    for (const doc of await loadProductions(log)) {
      if (doc.status === 'active' && doc.activatedAt && Number.isFinite(Date.parse(doc.activatedAt))) {
        activeCount++;
      }
      // Counter is cumulative allocation seconds for the resource, including the
      // current partial hour. Billing never reads it (JSON buckets do).
      const total = Object.values(hoursForProduction(doc, nowMs, true)).reduce((sum, s) => sum + s, 0);
      if (total > 0) {
        const resource = escapeLabel(resourceId(doc._id));
        counterSamples.push(
          `osc_gpu_seconds_total{tenant="${tenant}",resource="${resource}",gpu_pool="${pool}",gpu_class="${cls}"} ${total}`,
        );
      }
    }
    // The gauge is always emitted when metering is on (0 when nothing runs).
    gaugeSamples.push(`osc_gpu_active{tenant="${tenant}",gpu_pool="${pool}"} ${activeCount}`);
  }

  const lines = [
    '# HELP osc_gpu_seconds_total Shared GPU time consumed, in seconds.',
    '# TYPE osc_gpu_seconds_total counter',
    ...counterSamples,
    '# HELP osc_gpu_active Number of GPU-consuming workloads running right now.',
    '# TYPE osc_gpu_active gauge',
    ...gaugeSamples,
  ];
  return lines.join('\n') + '\n';
}
