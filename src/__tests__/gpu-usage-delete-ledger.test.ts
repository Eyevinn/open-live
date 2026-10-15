/**
 * DELETE must not lose GPU usage buckets (#503 FIX 1, issue #500).
 *
 * `gpuHours` lives only on the production doc, so `DELETE /api/v1/productions/:id`
 * — a normal path, e.g. deleting a production right after a show — would
 * permanently lose every retained closed-hour bucket AND the final partial hour.
 * `preserveGpuUsageOnDelete` settles the final partial hour and copies the
 * buckets into a `gpu-usage-ledger` record that OUTLIVES the production, and the
 * usage read folds that ledger back in under the same `production-<id>` resource.
 *
 * This exercises the whole path against a STATEFUL ledger store: a
 * delete-while-recording writes a ledger, and after the production doc is gone
 * (loadProductions → []) the surviving buckets are still returned by
 * GET /api/v1/usage/gpu's builder. GPU_POOL is set so metering is enabled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';

// Stateful in-memory ledger collection, so a write is actually readable back.
const ledgerStore = new Map<string, Record<string, unknown>>();
const ledgerGet = vi.fn(async (id: string) => {
  const doc = ledgerStore.get(id);
  if (!doc) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return doc;
});
const ledgerInsert = vi.fn(async (doc: Record<string, unknown>) => {
  ledgerStore.set(doc._id as string, { ...doc, _rev: '1-abc' });
  return { ok: true, id: doc._id as string, rev: '1-abc' };
});
const ledgerFindTrusted = vi.fn(async () => ({ docs: [...ledgerStore.values()] }));

// Productions: empty by default (the one under test is "deleted").
const productionFindTrusted = vi.fn(async () => ({ docs: [] as unknown[] }));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ findTrusted: productionFindTrusted, get: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getGpuUsageLedgerDb: () => ({ findTrusted: ledgerFindTrusted, get: ledgerGet, insert: ledgerInsert }),
  isDbConnected: () => true,
}));

const { preserveGpuUsageOnDelete, buildGpuUsageResponse } = await import('../services/gpu-usage.js');

const log = { warn() {}, info() {}, error() {} } as never;
const ms = (iso: string) => Date.parse(iso);

beforeEach(() => {
  ledgerStore.clear();
  ledgerGet.mockClear();
  ledgerInsert.mockClear();
  ledgerFindTrusted.mockClear();
  productionFindTrusted.mockClear();
});

describe('preserveGpuUsageOnDelete + usage read (#503 FIX 1)', () => {
  it('a production deleted while recording keeps its buckets in the usage read', async () => {
    // Live production: one persisted closed hour (12:00) plus a run that started
    // at 12:40; deleted at 13:30, so the final partial hour 13:00 = 1800s.
    const deletedAt = ms('2026-10-13T13:30:00Z');
    await preserveGpuUsageOnDelete(
      { _id: 'prod-del', status: 'active', activatedAt: '2026-10-13T12:40:00Z', gpuHours: { '2026-10-13T12:00:00Z': 1200 } },
      log,
      deletedAt,
    );

    // A ledger survives the (about-to-happen) doc destroy, carrying both the
    // retained closed hour and the settled final partial hour.
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
    const ledgerDoc = ledgerInsert.mock.calls[0]![0] as { type: string; productionId: string; gpuHours: Record<string, number> };
    expect(ledgerDoc.type).toBe('gpu-usage-ledger');
    expect(ledgerDoc.productionId).toBe('prod-del');
    expect(ledgerDoc.gpuHours).toEqual({ '2026-10-13T12:00:00Z': 1200, '2026-10-13T13:00:00Z': 1800 });

    // Production doc is now gone (loadProductions → []), yet the usage read still
    // reports the surviving buckets under the SAME resource id once both hours
    // have closed (read at 14:10, settledThrough 14:00).
    const res = await buildGpuUsageResponse({}, log, ms('2026-10-13T14:10:00Z'));
    expect(res.hours).toEqual([
      { hour: '2026-10-13T12:00:00Z', tenantId: 'unattributed', resource: 'production-prod-del', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 1200 },
      { hour: '2026-10-13T13:00:00Z', tenantId: 'unattributed', resource: 'production-prod-del', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 1800 },
    ]);
  });

  it('preserves the retained buckets of an already-stopped production (no activatedAt)', async () => {
    await preserveGpuUsageOnDelete(
      { _id: 'prod-ended', status: 'ended', gpuHours: { '2026-10-13T10:00:00Z': 600 } },
      log,
      ms('2026-10-13T13:30:00Z'),
    );
    expect(ledgerInsert).toHaveBeenCalledTimes(1);
    const ledgerDoc = ledgerInsert.mock.calls[0]![0] as { gpuHours: Record<string, number> };
    expect(ledgerDoc.gpuHours).toEqual({ '2026-10-13T10:00:00Z': 600 });

    const res = await buildGpuUsageResponse({}, log, ms('2026-10-13T14:10:00Z'));
    expect(res.hours).toEqual([
      { hour: '2026-10-13T10:00:00Z', tenantId: 'unattributed', resource: 'production-prod-ended', gpuPool: 'fra-1', gpuClass: 'shared', seconds: 600 },
    ]);
  });

  it('writes no ledger when the production never accrued', async () => {
    await preserveGpuUsageOnDelete({ _id: 'prod-empty', status: 'inactive', gpuHours: {} }, log, ms('2026-10-13T13:30:00Z'));
    expect(ledgerInsert).not.toHaveBeenCalled();
  });
});
