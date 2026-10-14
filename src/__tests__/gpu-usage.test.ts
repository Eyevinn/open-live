/**
 * Unit tests for the shared-GPU usage accrual service (issue #500,
 * docs/specs/shared-gpu-usage-metering.md, ADR-005).
 *
 * Covers the allocation-basis math (closed-hour bucketing, clamping, partial
 * hours), the restart-resume and abnormal-end settle behaviours, and the two
 * read surfaces (JSON buckets + Prometheus text) against a mocked CouchDB. All
 * functions take an explicit `nowMs`, so time is deterministic without fake
 * timers.
 *
 * GPU_POOL is set before import so metering is enabled (config reads env once at
 * module load). The DB is mocked; the pure math functions never touch it.
 */

import { describe, it, expect, vi } from 'vitest';

process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';

const mockFindTrusted = vi.fn();
const mockIsDbConnected = vi.fn().mockReturnValue(true);

const mockLedgerFindTrusted = vi.fn(async () => ({ docs: [] }));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ findTrusted: mockFindTrusted, get: vi.fn(), insert: vi.fn() }),
  getGpuUsageLedgerDb: () => ({ findTrusted: mockLedgerFindTrusted, get: vi.fn(), insert: vi.fn() }),
  isDbConnected: () => mockIsDbConnected(),
}));

const {
  startOfUtcHour,
  isoHour,
  computeHourBuckets,
  pruneExpiredHours,
  settleOnStop,
  buildGpuUsageResponse,
  buildPrometheusMetrics,
  GPU_USAGE_STANDARD,
  GpuUsageStoreUnavailableError,
} = await import('../services/gpu-usage.js');

const log = { warn() {}, info() {}, error() {} } as never;
const ms = (iso: string) => Date.parse(iso);

describe('allocation-basis bucketing', () => {
  it('buckets a full and a partial hour, clamped to 0..3600', () => {
    // 13:00 → 14:30 = one full hour (13:00) + 30 min into 14:00.
    const buckets = computeHourBuckets(ms('2026-10-13T13:00:00Z'), ms('2026-10-13T14:30:00Z'));
    expect(buckets).toEqual({
      '2026-10-13T13:00:00Z': 3600,
      '2026-10-13T14:00:00Z': 1800,
    });
  });

  it('emits top-of-hour UTC keys without milliseconds', () => {
    expect(isoHour(ms('2026-10-13T13:42:17.512Z'))).toBe('2026-10-13T13:00:00Z');
    expect(startOfUtcHour(ms('2026-10-13T13:42:17.512Z'))).toBe(ms('2026-10-13T13:00:00Z'));
  });

  it('skips hours already present (append-only / idempotent)', () => {
    const existing = { '2026-10-13T13:00:00Z': 3600 };
    const buckets = computeHourBuckets(ms('2026-10-13T13:00:00Z'), ms('2026-10-13T14:30:00Z'), existing);
    expect(buckets).toEqual({ '2026-10-13T14:00:00Z': 1800 });
  });

  it('returns nothing when the interval is empty or inverted', () => {
    expect(computeHourBuckets(ms('2026-10-13T13:00:00Z'), ms('2026-10-13T13:00:00Z'))).toEqual({});
    expect(computeHourBuckets(ms('2026-10-13T14:00:00Z'), ms('2026-10-13T13:00:00Z'))).toEqual({});
  });
});

describe('restart resumes from the recorded start, not zero', () => {
  it('accrues the hours that elapsed across a downtime gap from activatedAt', () => {
    // Flow started 10:15, the pre-shutdown sweep had settled 10:00 (10:15→11:00
    // = 2700s). The process was then down 11:00–13:30; on restart the flow is
    // still live, so the sweep settles the fully-closed hours since, from the
    // preserved activatedAt — i.e. it resumes from 10:15, not from the restart.
    const activatedAt = '2026-10-13T10:15:00Z';
    const existing = { '2026-10-13T10:00:00Z': 2700 };
    const fresh = computeHourBuckets(activatedAt ? ms(activatedAt) : 0, startOfUtcHour(ms('2026-10-13T13:30:00Z')), existing);
    expect(fresh).toEqual({
      '2026-10-13T11:00:00Z': 3600,
      '2026-10-13T12:00:00Z': 3600,
    });
  });
});

describe('settleOnStop — abnormal / explicit end settles the final partial hour', () => {
  it('includes the partial hour the production stopped in', () => {
    const merged = settleOnStop({ activatedAt: '2026-10-13T13:00:00Z', gpuHours: {} }, ms('2026-10-13T13:30:00Z'));
    expect(merged).toEqual({ '2026-10-13T13:00:00Z': 1800 });
  });

  it('merges onto existing closed hours', () => {
    const merged = settleOnStop(
      { activatedAt: '2026-10-13T12:40:00Z', gpuHours: { '2026-10-13T12:00:00Z': 1200 } },
      ms('2026-10-13T13:30:00Z'),
    );
    expect(merged).toEqual({
      '2026-10-13T12:00:00Z': 1200,
      '2026-10-13T13:00:00Z': 1800,
    });
  });

  it('is a no-op when the production never accrued', () => {
    expect(settleOnStop({ gpuHours: {} }, ms('2026-10-13T13:30:00Z'))).toBeUndefined();
  });
});

describe('pruneExpiredHours', () => {
  it('drops buckets older than the retention window', () => {
    const now = ms('2026-10-13T13:00:00Z');
    // Default retention is 2160h (90 days). 100 days ago is expired.
    const pruned = pruneExpiredHours(
      { '2026-07-05T13:00:00Z': 3600, '2026-10-13T12:00:00Z': 3600 },
      now,
    );
    expect(pruned).toEqual({ '2026-10-13T12:00:00Z': 3600 });
  });
});

describe('GET /api/v1/usage/gpu response builder', () => {
  it('emits closed buckets only, derives current-life closed hours, applies since', async () => {
    mockIsDbConnected.mockReturnValue(true);
    mockFindTrusted.mockResolvedValue({
      docs: [
        // Active production: one persisted closed hour + a live run whose current
        // partial hour (13:00) must NOT be emitted.
        { _id: 'prod-a', type: 'production', status: 'active', activatedAt: '2026-10-13T12:30:00Z', gpuHours: { '2026-10-13T11:00:00Z': 3600 } },
        // Stopped production with one persisted closed hour.
        { _id: 'prod-b', type: 'production', status: 'ended', gpuHours: { '2026-10-13T10:00:00Z': 600 } },
      ],
    });

    const res = await buildGpuUsageResponse({}, log, ms('2026-10-13T13:20:00Z'));
    expect(res.standard).toBe(GPU_USAGE_STANDARD);
    expect(res.basis).toBe('allocation');
    expect(res.settledThrough).toBe('2026-10-13T13:00:00Z');
    expect(res.service).toBeTruthy();

    // 11:00 (persisted) + 12:00 (derived from activatedAt, 12:30→13:00 = 1800) for
    // prod-a; 10:00 for prod-b. The current partial hour 13:00 is excluded.
    expect(res.hours).toEqual([
      { hour: '2026-10-13T10:00:00Z', tenantId: 'unattributed', resource: 'production-prod-b', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 600 },
      { hour: '2026-10-13T11:00:00Z', tenantId: 'unattributed', resource: 'production-prod-a', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 3600 },
      { hour: '2026-10-13T12:00:00Z', tenantId: 'unattributed', resource: 'production-prod-a', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 1800 },
    ]);

    const sinceRes = await buildGpuUsageResponse({ sinceMs: ms('2026-10-13T11:00:00Z') }, log, ms('2026-10-13T13:20:00Z'));
    expect(sinceRes.hours.map((h) => h.hour)).toEqual(['2026-10-13T12:00:00Z']);
  });
});

describe('GET /metrics text builder', () => {
  it('renders the counter + gauge families with the right labels', async () => {
    mockIsDbConnected.mockReturnValue(true);
    mockFindTrusted.mockResolvedValue({
      docs: [
        { _id: 'prod-a', type: 'production', status: 'active', activatedAt: '2026-10-13T13:00:00Z', gpuHours: { '2026-10-13T12:00:00Z': 3600 } },
      ],
    });
    const text = await buildPrometheusMetrics(log, ms('2026-10-13T13:30:00Z'));
    expect(text).toContain('# TYPE osc_gpu_seconds_total counter');
    expect(text).toContain('# TYPE osc_gpu_active gauge');
    // 3600 (persisted 12:00) + 1800 (live partial 13:00) = 5400.
    expect(text).toContain('osc_gpu_seconds_total{tenant="unattributed",resource="production-prod-a",gpu_pool="fra-1",gpu_class="shared"} 5400');
    expect(text).toContain('osc_gpu_active{tenant="unattributed",gpu_pool="fra-1"} 1');
  });
});

describe('full-set scan is not capped at Mango\'s 25-doc default (#503 FIX 2)', () => {
  it('bookmark-pages the whole production set and bills every doc', async () => {
    mockIsDbConnected.mockReturnValue(true);
    mockLedgerFindTrusted.mockResolvedValue({ docs: [] });
    const closedHour = '2026-10-13T11:00:00Z';
    const makeDoc = (i: number) => ({ _id: `prod-${i}`, type: 'production', status: 'ended', gpuHours: { [closedHour]: 60 } });
    // Two pages: a full 200-doc page (with a bookmark) then a short 30-doc page.
    // 230 > 25, so the old unbounded find() would have dropped 205 of them.
    const page1 = Array.from({ length: 200 }, (_, i) => makeDoc(i));
    const page2 = Array.from({ length: 30 }, (_, i) => makeDoc(200 + i));
    mockFindTrusted.mockReset();
    mockFindTrusted
      .mockResolvedValueOnce({ docs: page1, bookmark: 'bm-1' })
      .mockResolvedValueOnce({ docs: page2, bookmark: 'bm-2' });

    const res = await buildGpuUsageResponse({}, log, ms('2026-10-13T13:00:00Z'));

    // Every one of the 230 productions is billed for its closed hour.
    expect(res.hours).toHaveLength(230);
    // Pagination actually ran (two pages), each query carried an explicit limit
    // well above Mango's 25-doc cap, and the second page followed the bookmark.
    expect(mockFindTrusted).toHaveBeenCalledTimes(2);
    for (const call of mockFindTrusted.mock.calls) {
      expect((call[0] as { limit?: number }).limit).toBeGreaterThan(25);
    }
    expect((mockFindTrusted.mock.calls[1]![0] as { bookmark?: string }).bookmark).toBe('bm-1');
  });
});

describe('JSON endpoint distinguishes db-down from zero (#503 FIX 3)', () => {
  it('throws GpuUsageStoreUnavailableError (→ 503) when metering is on but the DB is down', async () => {
    mockIsDbConnected.mockReturnValue(false);
    await expect(buildGpuUsageResponse({}, log, ms('2026-10-13T13:00:00Z'))).rejects.toBeInstanceOf(
      GpuUsageStoreUnavailableError,
    );
    mockIsDbConnected.mockReturnValue(true);
  });
});
