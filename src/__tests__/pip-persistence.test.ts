/**
 * Regression tests for issue #177 — "Production graphics (PiP) configuration is
 * lost on deactivation, and setup does not persist".
 *
 * Root cause: the PiP layout set via the WS SET_PIP handler was stored ONLY in
 * the in-memory `pipConfigsByProduction` cache and never written to the
 * ProductionDoc. On deactivate the cache is wiped (clearPipState); on the next
 * connect it was re-seeded with EMPTY slots, so the operator's PiP placement was
 * lost across every activate/deactivate cycle (and every server restart).
 *
 * Fix: persist pipConfigs on the ProductionDoc (via updateProductionDoc) and
 * re-hydrate the cache from the doc on connect (hydratePipConfigsFromDoc).
 *
 * These tests exercise the persistence/hydration seam directly. CouchDB is
 * mocked as a tiny in-memory store so updateProductionDoc round-trips like the
 * real thing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProductionDoc } from '../db/types.js';
import type { PipConfig } from '../lib/strom.js';

// ---------------------------------------------------------------------------
// Mock CouchDB with a minimal in-memory store keyed by _id.
// ---------------------------------------------------------------------------

const store = new Map<string, ProductionDoc>();

const mockGet = vi.fn(async (id: string) => {
  const doc = store.get(id);
  if (!doc) {
    const err = new Error('not_found') as Error & { statusCode: number };
    err.statusCode = 404;
    throw err;
  }
  return structuredClone(doc);
});

const mockInsert = vi.fn(async (doc: ProductionDoc) => {
  store.set(doc._id, structuredClone(doc));
  return { id: doc._id, rev: `${(store.size)}-rev`, ok: true };
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// updateProductionDoc lives in the productions route module; import AFTER the db mock.
import { updateProductionDoc } from '../routes/productions.js';
import {
  setPipConfigSlot,
  getPipConfigs,
  hydratePipConfigsFromDoc,
  clearPipState,
} from '../ws/controller.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProductionDoc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    _id: 'prod-pip-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'active',
    sources: [],
    values: { num_pips: 2 },
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    stromFlowId: 'flow-1',
    mixerBlockId: 'mixer-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const SAMPLE_PIP: PipConfig = {
  bg: 0,
  zones: [{ rect: { x: 0.6, y: 0.6, w: 0.35, h: 0.35 }, capacity: 1, sources: [1] }],
  transforms: {},
};

/** Simulate the persistence side-effect of the SET_PIP handler. */
async function simulateSetPip(productionId: string, pip: number, cfg: PipConfig) {
  setPipConfigSlot(productionId, pip, cfg);
  await updateProductionDoc(productionId, { pipConfigs: getPipConfigs(productionId) ?? [] });
}

describe('PiP configuration persistence (issue #177)', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    // Ensure no stale in-memory cache leaks between tests.
    clearPipState('prod-pip-1');
    store.set('prod-pip-1', makeProductionDoc());
  });

  it('persists the PiP layout to the ProductionDoc when SET_PIP runs', async () => {
    await simulateSetPip('prod-pip-1', 0, SAMPLE_PIP);

    const persisted = store.get('prod-pip-1');
    expect(persisted?.pipConfigs).toBeDefined();
    expect(persisted?.pipConfigs?.[0]).toEqual(SAMPLE_PIP);
  });

  it('deactivate (clearPipState) does NOT wipe the persisted pipConfigs on the doc', async () => {
    await simulateSetPip('prod-pip-1', 0, SAMPLE_PIP);

    // Deactivate: the in-memory cache is flushed, but the DB doc must be untouched.
    clearPipState('prod-pip-1');
    expect(getPipConfigs('prod-pip-1')).toBeUndefined();

    const persisted = store.get('prod-pip-1');
    expect(persisted?.pipConfigs?.[0]).toEqual(SAMPLE_PIP);
  });

  it('restores the PiP layout from the doc on reconnect after a deactivate cycle', async () => {
    // 1. Operator configures a PiP while the production is active.
    await simulateSetPip('prod-pip-1', 0, SAMPLE_PIP);

    // 2. Deactivate wipes the live cache.
    clearPipState('prod-pip-1');
    expect(getPipConfigs('prod-pip-1')).toBeUndefined();

    // 3. Reconnect: hydrate from the persisted doc (as the WS connect handler does).
    const doc = await mockGet('prod-pip-1');
    const restored = hydratePipConfigsFromDoc(doc);

    // The operator's layout is back — not an empty slot.
    expect(restored).not.toBeNull();
    expect(getPipConfigs('prod-pip-1')?.[0]).toEqual(SAMPLE_PIP);
    // restored is returned so the caller can re-push it to Strom.
    expect(restored?.[0]).toEqual(SAMPLE_PIP);
  });

  it('seeds empty slots from num_pips when nothing was ever persisted', () => {
    clearPipState('prod-pip-1');
    const doc = makeProductionDoc({ pipConfigs: undefined, values: { num_pips: 3 } });
    const restored = hydratePipConfigsFromDoc(doc);

    // No persisted layout to restore → returns null but seeds empty slots.
    expect(restored).toBeNull();
    const seeded = getPipConfigs('prod-pip-1');
    expect(seeded).toHaveLength(3);
    expect(seeded?.every((c) => c.bg === null && c.zones.length === 0)).toBe(true);
  });

  it('does not clobber a live cache when the doc is re-read (hydration is cold-only)', async () => {
    // Live edit present in the cache.
    setPipConfigSlot('prod-pip-1', 0, SAMPLE_PIP);
    // A stale doc (no pipConfigs) must not overwrite the live layout.
    const staleDoc = makeProductionDoc({ pipConfigs: undefined });
    const restored = hydratePipConfigsFromDoc(staleDoc);

    expect(restored).toBeNull();
    expect(getPipConfigs('prod-pip-1')?.[0]).toEqual(SAMPLE_PIP);
  });
});
