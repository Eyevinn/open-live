/**
 * GPU usage accrual floor at metering enablement (issue #535, part of #526).
 *
 * `activatedAt` is written on every activation even with metering off and is
 * kept across a restart, so without a floor a production live across the restart
 * that enabled metering would be back-charged for time before metering was on.
 * `startGpuUsageSweep` persists an `enabledAt` marker once per instance and every
 * accrual path starts at `max(activatedAt, enabledAt)`. With the DB down the floor
 * is the in-memory sweep start (may undercharge, never back-charges).
 *
 * GPU_POOL is set before import so metering is enabled. The DB is mocked with a
 * stateful marker store so a write is readable back by a second start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env['GPU_POOL'] = 'fra-1';
process.env['GPU_CLASS'] = 'shared';

type StoredDoc = Record<string, unknown>;

function couchError(statusCode: number): Error & { statusCode: number } {
  const err = new Error(String(statusCode)) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

const markerStore = new Map<string, StoredDoc>();
const markerGet = vi.fn(async (id: string) => {
  const doc = markerStore.get(id);
  if (!doc) throw couchError(404);
  return doc;
});
const markerInsert = vi.fn(async (doc: StoredDoc) => {
  if (markerStore.has(doc._id as string) && !doc._rev) throw couchError(409);
  markerStore.set(doc._id as string, { ...doc, _rev: '1-abc' });
  return { ok: true, id: doc._id as string, rev: '1-abc' };
});

const productionStore = new Map<string, StoredDoc>();
const productionFindTrusted = vi.fn(async () => ({ docs: [...productionStore.values()] }));
const productionGet = vi.fn(async (id: string) => {
  const doc = productionStore.get(id);
  if (!doc) throw couchError(404);
  return doc;
});
const productionInsert = vi.fn(async (doc: StoredDoc) => {
  productionStore.set(doc._id as string, doc);
  return { ok: true };
});

let dbConnected = true;

vi.mock('../db/index.js', () => ({
  getDb: () => ({ findTrusted: productionFindTrusted, get: productionGet, insert: productionInsert }),
  getGpuUsageLedgerDb: () => ({ findTrusted: vi.fn(async () => ({ docs: [] })), get: vi.fn(), insert: vi.fn() }),
  getGpuMeteringStateDb: () => ({ get: markerGet, insert: markerInsert }),
  isDbConnected: () => dbConnected,
}));

const {
  startGpuUsageSweep,
  isGpuUsageSweepRunning,
  getGpuAccrualFloorMs,
  settleOnStop,
  settleActiveProductions,
  buildGpuUsageResponse,
  GPU_METERING_STATE_DOC_ID,
  __resetGpuUsageSweepForTests,
} = await import('../services/gpu-usage.js');

const log = { warn() {}, info() {}, error() {} } as never;
const ms = (iso: string) => Date.parse(iso);

beforeEach(() => {
  markerStore.clear();
  productionStore.clear();
  vi.clearAllMocks();
  dbConnected = true;
  __resetGpuUsageSweepForTests();
});

afterEach(() => {
  __resetGpuUsageSweepForTests();
});

describe('accrual floor marker (#535)', () => {
  it('persists enabledAt on the first start', async () => {
    const enabledAt = ms('2026-10-17T12:20:00Z');
    await startGpuUsageSweep(log, enabledAt);

    expect(isGpuUsageSweepRunning()).toBe(true);
    expect(getGpuAccrualFloorMs()).toBe(enabledAt);
    expect(markerInsert).toHaveBeenCalledTimes(1);
    expect(markerStore.get(GPU_METERING_STATE_DOC_ID)).toMatchObject({
      _id: GPU_METERING_STATE_DOC_ID,
      type: 'gpu-metering-state',
      enabledAt: '2026-10-17T12:20:00.000Z',
    });
  });

  it('does not overwrite the marker on a second start', async () => {
    const firstStart = ms('2026-10-17T12:20:00Z');
    await startGpuUsageSweep(log, firstStart);
    __resetGpuUsageSweepForTests(); // simulate a restart: in-memory state is gone

    const secondStart = ms('2026-10-18T09:00:00Z');
    await startGpuUsageSweep(log, secondStart);

    expect(markerInsert).toHaveBeenCalledTimes(1);
    expect(markerStore.get(GPU_METERING_STATE_DOC_ID)?.['enabledAt']).toBe('2026-10-17T12:20:00.000Z');
    expect(getGpuAccrualFloorMs()).toBe(firstStart);
  });

  it('uses the winner\'s marker when it loses a create race (409)', async () => {
    const winner = ms('2026-10-17T12:00:00Z');
    markerGet.mockImplementationOnce(async () => {
      // Another process creates the marker between our read and our insert.
      markerStore.set(GPU_METERING_STATE_DOC_ID, {
        _id: GPU_METERING_STATE_DOC_ID,
        type: 'gpu-metering-state',
        enabledAt: new Date(winner).toISOString(),
      });
      throw couchError(404);
    });
    await startGpuUsageSweep(log, ms('2026-10-17T12:20:00Z'));
    expect(getGpuAccrualFloorMs()).toBe(winner);
  });

  it('with the DB down, the floor is the sweep start and no marker is written', async () => {
    dbConnected = false;
    const sweepStart = ms('2026-10-17T12:20:00Z');
    await startGpuUsageSweep(log, sweepStart);

    expect(getGpuAccrualFloorMs()).toBe(sweepStart);
    expect(markerGet).not.toHaveBeenCalled();
    expect(markerInsert).not.toHaveBeenCalled();

    // A production activated hours earlier accrues only from the sweep start.
    expect(settleOnStop({ activatedAt: '2026-10-17T10:00:00Z' }, ms('2026-10-17T13:00:00Z'))).toEqual({
      '2026-10-17T12:00:00Z': 2400,
    });
  });

  it('when the marker read fails (DB connected), the floor is the sweep start', async () => {
    markerGet.mockRejectedValueOnce(couchError(500));
    const sweepStart = ms('2026-10-17T12:20:00Z');
    await startGpuUsageSweep(log, sweepStart);
    expect(getGpuAccrualFloorMs()).toBe(sweepStart);
    expect(markerInsert).not.toHaveBeenCalled();
  });
});

describe('accrual starts at max(activatedAt, enabledAt) (#535)', () => {
  const enabledAt = ms('2026-10-17T12:20:00Z');

  beforeEach(async () => {
    await startGpuUsageSweep(log, enabledAt);
  });

  it('a production activated before enabledAt accrues only from enabledAt (stop path)', () => {
    // Live since 10:00 (metering off), metering enabled 12:20, stopped 13:30.
    expect(settleOnStop({ activatedAt: '2026-10-17T10:00:00Z' }, ms('2026-10-17T13:30:00Z'))).toEqual({
      '2026-10-17T12:00:00Z': 2400,
      '2026-10-17T13:00:00Z': 1800,
    });
  });

  it('a production activated after enabledAt is unchanged', () => {
    expect(settleOnStop({ activatedAt: '2026-10-17T12:40:00Z' }, ms('2026-10-17T13:30:00Z'))).toEqual({
      '2026-10-17T12:00:00Z': 1200,
      '2026-10-17T13:00:00Z': 1800,
    });
  });

  it('the settle sweep persists no hour before enabledAt', async () => {
    productionStore.set('prod-a', {
      _id: 'prod-a',
      type: 'production',
      status: 'active',
      activatedAt: '2026-10-17T10:00:00Z',
    });
    await settleActiveProductions(log, ms('2026-10-17T14:10:00Z'));
    expect(productionStore.get('prod-a')?.['gpuHours']).toEqual({
      '2026-10-17T12:00:00Z': 2400,
      '2026-10-17T13:00:00Z': 3600,
    });
  });

  it('the usage read reports no hour before enabledAt for a live production', async () => {
    productionStore.set('prod-a', {
      _id: 'prod-a',
      type: 'production',
      status: 'active',
      activatedAt: '2026-10-17T10:00:00Z',
    });
    productionStore.set('prod-b', {
      _id: 'prod-b',
      type: 'production',
      status: 'active',
      activatedAt: '2026-10-17T12:40:00Z',
    });
    const res = await buildGpuUsageResponse({}, log, ms('2026-10-17T14:10:00Z'));
    expect(res.hours.map((h) => [h.resource, h.hour, h.seconds])).toEqual([
      ['production-prod-a', '2026-10-17T12:00:00Z', 2400],
      ['production-prod-b', '2026-10-17T12:00:00Z', 1200],
      ['production-prod-a', '2026-10-17T13:00:00Z', 3600],
      ['production-prod-b', '2026-10-17T13:00:00Z', 3600],
    ]);
  });
});
