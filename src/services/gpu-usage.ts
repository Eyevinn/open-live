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
import type Nano from 'nano';
import { config, isGpuMeteringEnabled } from '../config.js';
import { getDb, getGpuUsageLedgerDb, isDbConnected } from '../db/index.js';
import type { ProductionDoc, GpuUsageLedgerDoc } from '../db/types.js';
import { renderProductionGateMetrics } from './production-gate.js';

const HOUR_MS = 3_600_000;

/**
 * Page size for the full-table usage scans. CouchDB Mango silently caps an
 * unbounded `find()`/`findTrusted()` at 25 docs (so an instance with >25
 * production or ledger docs would under-bill), so every usage scan pages through
 * with this explicit limit until a short page ends the set — the same bookmark
 * pagination `migrate-audio-channel-order.ts` uses. 200 matches the explicit
 * `limit` the activation conflict check already sets.
 */
const USAGE_SCAN_PAGE_LIMIT = 200;

/**
 * Bookmark-paginate a trusted (literal-selector, no request data — #257) Mango
 * scan to the FULL result set, past the 25-doc Mango cap. Mirrors the paging loop
 * in `migrate-audio-channel-order.ts`: a page shorter than the limit ends the scan.
 */
async function findAllTrusted<T>(
  scope: { findTrusted: (query: Nano.MangoQuery) => Promise<Nano.MangoResponse<T>> },
  selector: Nano.MangoQuery['selector'],
  fields?: string[],
): Promise<T[]> {
  const out: T[] = [];
  let bookmark: string | undefined;
  for (;;) {
    const page = await scope.findTrusted({
      selector,
      limit: USAGE_SCAN_PAGE_LIMIT,
      ...(fields ? { fields } : {}),
      ...(bookmark ? { bookmark } : {}),
    });
    const docs = Array.isArray(page?.docs) ? page.docs : [];
    out.push(...docs);
    bookmark = page?.bookmark;
    if (docs.length < USAGE_SCAN_PAGE_LIMIT) break;
  }
  return out;
}

/**
 * Thrown by {@link buildGpuUsageResponse} when metering is ENABLED but the
 * backing store is unreachable OR a usage query fails while connected. The JSON usage endpoint maps it to `503`
 * (`docs/standards/osc-gpu-usage-v1.md` §2) so a transient DB outage is
 * distinguishable from genuine zero usage — a `200 { hours: [] }` would silently
 * under-report. Metering-disabled instances still report zero (`200 hours:[]`):
 * they never read the store, so there is nothing to be unavailable.
 */
export class GpuUsageStoreUnavailableError extends Error {
  readonly statusCode = 503;
  constructor() {
    super('GPU usage backing store is unavailable');
    this.name = 'GpuUsageStoreUnavailableError';
  }
}

/** Deterministic ledger id for a production, so delete is an idempotent upsert. */
function ledgerId(productionId: string): string {
  return `gpu-ledger-${productionId}`;
}

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

/**
 * Preserve a production's shared-GPU usage BEFORE its doc is destroyed
 * (`DELETE /api/v1/productions/:id`, issue #500). Deleting a production right
 * after a show is a normal path and those hours must stay billable, but
 * `gpuHours` lives only on the production doc — so this settles the final partial
 * hour (for a still-live production) or keeps the already-settled buckets (for a
 * stopped one), then upserts them into a `gpu-usage-ledger` record that OUTLIVES
 * the production. The usage read path folds the ledger back in under the same
 * `production-<id>` resource, so `/api/v1/usage/gpu` and `/metrics` keep
 * reporting the buckets within the retention window.
 *
 * Best-effort and self-contained (upsert-on-409, retention-pruned): metering off
 * or nothing accrued writes no ledger, and a failed write is logged, never
 * thrown — teardown must not be blocked by a ledger write, matching the
 * Strom/recording teardown contract in the DELETE handler.
 */
export async function preserveGpuUsageOnDelete(
  doc: Pick<ProductionDoc, '_id' | 'status' | 'activatedAt' | 'gpuHours'>,
  log: FastifyBaseLogger,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!isGpuMeteringEnabled()) return;
  // A live production (status 'active' with activatedAt) settles its final
  // partial hour; a stopped one has no activatedAt, so settleOnStop is undefined
  // and we keep its already-settled closed buckets. Prune expired ones either way.
  const settled = settleOnStop(doc, nowMs) ?? pruneExpiredHours(doc.gpuHours ?? {}, nowMs);
  if (Object.keys(settled).length === 0) return;

  const id = ledgerId(doc._id);
  const nowIso = new Date(nowMs).toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ledgerDb = getGpuUsageLedgerDb();
      let prior: GpuUsageLedgerDoc | undefined;
      try {
        prior = await ledgerDb.get(id);
      } catch {
        // No prior ledger (first delete) — create a fresh one.
      }
      const ledger: GpuUsageLedgerDoc = {
        _id: id,
        ...(prior?._rev ? { _rev: prior._rev } : {}),
        type: 'gpu-usage-ledger',
        productionId: doc._id,
        gpuHours: settled,
        createdAt: prior?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      await ledgerDb.insert(ledger);
      return;
    } catch (err) {
      if (isConflict(err) && attempt < 2) continue;
      log.warn({ err, productionId: doc._id }, '[gpu-usage] failed to preserve usage ledger on delete');
      return;
    }
  }
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
  let docs: { _id: string }[];
  try {
    // Page the FULL active set — an unbounded findTrusted() is capped at 25 docs
    // by Mango, which would leave the 26th+ live production's hours un-settled
    // (under-billing). Only `_id` is needed; settleOneProduction re-reads each.
    docs = await findAllTrusted<{ _id: string }>(getDb(), { type: 'production', status: 'active' }, ['_id']);
  } catch (err) {
    log.warn({ err }, '[gpu-usage] settle sweep query failed');
    return;
  }
  for (const doc of docs) {
    await settleOneProduction(doc._id, nowMs, log);
  }
}

let sweepInterval: NodeJS.Timeout | null = null;

/** Start the periodic settle sweep. No-op (logged) when metering is disabled. */
export function startGpuUsageSweep(log: FastifyBaseLogger): void {
  if (sweepInterval !== null) return;
  if (!isGpuMeteringEnabled()) {
    log.info(
      '[gpu-usage] Shared-GPU metering disabled (no GPU_POOL and no platform-default match) — settle sweep not started',
    );
    return;
  }
  log.info(
    `[gpu-usage] Shared-GPU metering enabled (source: ${config.gpuMeteringSource}, pool: ${config.gpuPool}, class: ${config.gpuClass}, settle: ${config.gpuSettleIntervalMs / 1000}s)`,
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
    // Page the FULL set — an unbounded findTrusted() is Mango-capped at 25 docs,
    // which would silently drop the 26th+ production from every usage read.
    return await findAllTrusted<ProductionDoc>(getDb(), { type: 'production' });
  } catch (err) {
    log.warn({ err }, '[gpu-usage] production query failed');
    // DB connected but the query failed: surface as 503, never an empty list
    // that would answer 200 with missing hours.
    throw new GpuUsageStoreUnavailableError();
  }
}

/**
 * Load the surviving usage ledgers written by {@link preserveGpuUsageOnDelete}
 * for deleted productions (issue #500). Paged for the same reason as the
 * production scan; a query failure throws {@link GpuUsageStoreUnavailableError}
 * (→ 503) rather than silently dropping deleted productions' hours.
 */
async function loadUsageLedgers(log: FastifyBaseLogger): Promise<GpuUsageLedgerDoc[]> {
  try {
    return await findAllTrusted<GpuUsageLedgerDoc>(getGpuUsageLedgerDb(), { type: 'gpu-usage-ledger' });
  } catch (err) {
    log.warn({ err }, '[gpu-usage] usage ledger query failed');
    throw new GpuUsageStoreUnavailableError();
  }
}

/**
 * Merge an hour→seconds map into a resource's accumulated buckets. Used to fold
 * a deleted production's surviving ledger onto the same `production-<id>`
 * resource as the (now-absent) production, so the read reports one resource, not
 * two. The brief window where a ledger and its not-yet-destroyed production
 * coexist carries identical buckets, so last-write-wins per hour is correct (not
 * additive — that would double-count).
 */
function mergeResourceHours(
  byResource: Map<string, Record<string, number>>,
  resource: string,
  hours: Record<string, number>,
): void {
  if (Object.keys(hours).length === 0) return;
  const existing = byResource.get(resource);
  byResource.set(resource, existing ? { ...existing, ...hours } : hours);
}

/**
 * Build the `osc-gpu-usage/v1` JSON response: closed UTC-hour buckets per
 * (hour × resource), across both live/stopped productions AND the surviving
 * ledgers of deleted ones (issue #500). `sinceMs`, when set, keeps only buckets
 * strictly after the cursor.
 *
 * Returns an empty `hours` array when metering is DISABLED (a self-hosted / BYO
 * instance reports zero shared-GPU time — it never reads the store). When
 * metering is enabled but the backing store is unreachable it throws
 * {@link GpuUsageStoreUnavailableError} so the endpoint answers `503`
 * (osc-gpu-usage-v1 §2), never a `200 { hours: [] }` that would hide a transient
 * outage behind genuine-zero semantics.
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
  if (!isGpuMeteringEnabled()) {
    return { ...base, hours: [] };
  }
  if (!isDbConnected()) {
    throw new GpuUsageStoreUnavailableError();
  }

  const pool = config.gpuPool!;
  const cls = config.gpuClass;
  const tenantId = tenantLabel();
  const hours: GpuHourBucket[] = [];

  // Fold live/stopped productions and the surviving ledgers of deleted ones onto
  // their shared `production-<id>` resource, so a deletion never drops hours.
  const byResource = new Map<string, Record<string, number>>();
  for (const doc of await loadProductions(log)) {
    mergeResourceHours(byResource, resourceId(doc._id), hoursForProduction(doc, nowMs, false));
  }
  for (const ledger of await loadUsageLedgers(log)) {
    mergeResourceHours(byResource, resourceId(ledger.productionId), pruneExpiredHours(ledger.gpuHours ?? {}, nowMs));
  }

  for (const [resource, hoursMap] of byResource) {
    for (const [hour, seconds] of Object.entries(hoursMap)) {
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
    try {
    // Counter is cumulative allocation seconds per resource, including the
    // current partial hour and the surviving ledgers of deleted productions
    // (so a delete does not reset the monotonic counter). Billing never reads it
    // (JSON buckets do). The gauge counts only live productions — a ledger is a
    // deleted production and never contributes to "running right now".
    const byResource = new Map<string, Record<string, number>>();
    for (const doc of await loadProductions(log)) {
      if (doc.status === 'active' && doc.activatedAt && Number.isFinite(Date.parse(doc.activatedAt))) {
        activeCount++;
      }
      mergeResourceHours(byResource, resourceId(doc._id), hoursForProduction(doc, nowMs, true));
    }
    for (const ledger of await loadUsageLedgers(log)) {
      mergeResourceHours(byResource, resourceId(ledger.productionId), pruneExpiredHours(ledger.gpuHours ?? {}, nowMs));
    }

    for (const [resource, hoursMap] of byResource) {
      const total = Object.values(hoursMap).reduce((sum, s) => sum + s, 0);
      if (total > 0) {
        counterSamples.push(
          `osc_gpu_seconds_total{tenant="${tenant}",resource="${escapeLabel(resource)}",gpu_pool="${pool}",gpu_class="${cls}"} ${total}`,
        );
      }
    }
    // The gauge is always emitted when metering is on (0 when nothing runs).
    gaugeSamples.push(`osc_gpu_active{tenant="${tenant}",gpu_pool="${pool}"} ${activeCount}`);
    } catch (err) {
      // A failed usage query (DB connected) now throws from the loaders; /metrics
      // degrades to headers only, like db-down, rather than a partial scrape.
      if (!(err instanceof GpuUsageStoreUnavailableError)) throw err;
      counterSamples.length = 0;
      gaugeSamples.length = 0;
    }
  }

  const lines = [
    '# HELP osc_gpu_seconds_total Shared GPU time consumed, in seconds.',
    '# TYPE osc_gpu_seconds_total counter',
    ...counterSamples,
    '# HELP osc_gpu_active Number of GPU-consuming workloads running right now.',
    '# TYPE osc_gpu_active gauge',
    ...gaugeSamples,
    ...renderProductionGateMetrics(),
  ];
  return lines.join('\n') + '\n';
}
