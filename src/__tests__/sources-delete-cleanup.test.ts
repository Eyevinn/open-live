/**
 * Deleting a source must leave no production pointing at it (issue #633).
 *
 * - AC1a: a production that is `ended` (deactivated) is cleaned like an
 *   `inactive` one — the assignment is removed and a `deletionWarnings` entry
 *   names the source. Previously only `inactive` was cleaned, so an `ended`
 *   production kept the orphan id.
 * - AC1b: two overlapping deletes of two sources used by the same production
 *   leave neither id. Previously each delete filtered `sources` from its own
 *   stale snapshot and the retry re-wrote that stale array, so the later write
 *   put the first-deleted id back.
 * - The `active`/`activating` refusal is unchanged.
 *
 * CouchDB is replaced by a small in-memory fake that enforces `_rev` (409 on a
 * stale revision), so the lost-update path is exercised for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProductionDoc } from '../db/types.js';
import { buildServer } from '../server.js';

type Doc = Record<string, unknown> & { _id: string; _rev?: string };

const store = vi.hoisted(() => ({
  productions: new Map<string, Doc>(),
  sources: new Map<string, Doc>(),
  /** When set, production `get`s wait here until released (forces overlap). */
  getGate: null as null | { waiting: number; release: () => void; ready: Promise<void>; needed: number },
}));

function conflict(): Error {
  return Object.assign(new Error('Document update conflict'), { statusCode: 409 });
}
function notFound(): Error {
  return Object.assign(new Error('missing'), { statusCode: 404 });
}
function bumpRev(rev: string | undefined): string {
  const n = rev ? parseInt(rev.split('-')[0]!, 10) : 0;
  return `${n + 1}-x`;
}

function matches(doc: Doc, selector: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(selector)) {
    const value = doc[key];
    if (cond && typeof cond === 'object' && '$in' in cond) {
      if (!(cond as { $in: unknown[] }).$in.includes(value)) return false;
    } else if (cond && typeof cond === 'object' && '$elemMatch' in cond) {
      const em = (cond as { $elemMatch: Record<string, unknown> }).$elemMatch;
      if (!Array.isArray(value) || !value.some((el) => matches(el as Doc, em))) return false;
    } else if (value !== cond) {
      return false;
    }
  }
  return true;
}

vi.mock('../db/index.js', () => {
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const find = async (q: { selector: Record<string, unknown> }) => ({
    docs: [...store.productions.values()].filter((d) => matches(d, q.selector)).map(clone),
  });
  const productionsDb = {
    get: async (id: string) => {
      const snapshot = store.productions.get(id);
      if (!snapshot) throw notFound();
      const copy = clone(snapshot);
      const gate = store.getGate;
      if (gate) {
        gate.waiting++;
        if (gate.waiting >= gate.needed) { store.getGate = null; gate.release(); }
        await gate.ready;
      }
      return copy;
    },
    insert: async (doc: Doc) => {
      const current = store.productions.get(doc._id);
      if (current && current._rev !== doc._rev) throw conflict();
      const rev = bumpRev(current?._rev);
      store.productions.set(doc._id, { ...clone(doc), _rev: rev });
      return { ok: true, id: doc._id, rev };
    },
    find,
    findTrusted: find,
  };
  const sourcesDb = {
    get: async (id: string) => {
      const d = store.sources.get(id);
      if (!d) throw notFound();
      return clone(d);
    },
    destroy: async (id: string) => {
      store.sources.delete(id);
      return { ok: true };
    },
  };
  return {
    getDb: () => productionsDb,
    getSourcesDb: () => sourcesDb,
    getOutputsDb: () => ({ get: async () => { throw notFound(); } }),
    getGraphicsDb: () => ({ get: async () => { throw notFound(); } }),
    connectDb: vi.fn().mockResolvedValue(undefined),
    isDbReady: vi.fn().mockResolvedValue(true),
    isDbConnected: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

function seedSource(id: string, name: string) {
  store.sources.set(id, { _id: id, _rev: '1-a', type: 'source', name, streamType: 'srt', address: 'srt://127.0.0.1:9000' });
}

function seedProduction(status: ProductionDoc['status'], sourceIds: string[]) {
  store.productions.set('prod-1', {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Demo Production',
    status,
    sources: sourceIds.map((sourceId, i) => ({ sourceId, mixerInput: `video_in_${i}` })),
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

function production(): ProductionDoc {
  return store.productions.get('prod-1') as unknown as ProductionDoc;
}

describe('DELETE /api/v1/sources/:id — production cleanup (#633)', () => {
  beforeEach(() => {
    store.productions.clear();
    store.sources.clear();
    store.getGate = null;
  });

  it('AC1a: removes the source from an ended production and records a deletion warning', async () => {
    seedSource('src-a', 'Camera 1');
    seedProduction('ended', ['__test1__', 'src-a']);
    const app = await buildServer();

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/sources/src-a' });

    expect(res.statusCode).toBe(204);
    expect(store.sources.has('src-a')).toBe(false);
    expect(production().sources.map((s) => s.sourceId)).toEqual(['__test1__']);
    expect(production().deletionWarnings).toEqual([{ type: 'source', name: 'Camera 1' }]);
  });

  it('still cleans an inactive production', async () => {
    seedSource('src-a', 'Camera 1');
    seedProduction('inactive', ['src-a']);
    const app = await buildServer();

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/sources/src-a' });

    expect(res.statusCode).toBe(204);
    expect(production().sources).toEqual([]);
    expect(production().deletionWarnings).toEqual([{ type: 'source', name: 'Camera 1' }]);
  });

  it.each(['active', 'activating'] as const)('still refuses while the production is %s', async (status) => {
    seedSource('src-a', 'Camera 1');
    seedProduction(status, ['src-a']);
    const app = await buildServer();

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/sources/src-a' });

    expect(res.statusCode).toBe(409);
    expect(store.sources.has('src-a')).toBe(true);
    expect(production().sources.map((s) => s.sourceId)).toEqual(['src-a']);
  });

  it('AC1b: two overlapping deletes on the same production leave neither id and both warnings', async () => {
    seedSource('src-a', 'Camera 1');
    seedSource('src-b', 'Camera 2');
    seedProduction('inactive', ['__test1__', 'src-a', 'src-b']);
    const app = await buildServer();

    // Hold the first production read of each delete until both have read, so
    // both start from the same `_rev`: one write wins, the other gets a 409.
    let release!: () => void;
    const ready = new Promise<void>((r) => { release = r; });
    store.getGate = { waiting: 0, needed: 2, release, ready };

    const [resA, resB] = await Promise.all([
      app.inject({ method: 'DELETE', url: '/api/v1/sources/src-a' }),
      app.inject({ method: 'DELETE', url: '/api/v1/sources/src-b' }),
    ]);

    expect(resA.statusCode).toBe(204);
    expect(resB.statusCode).toBe(204);
    expect(production().sources.map((s) => s.sourceId)).toEqual(['__test1__']);
    expect(production().deletionWarnings).toHaveLength(2);
    expect(production().deletionWarnings).toEqual(
      expect.arrayContaining([
        { type: 'source', name: 'Camera 1' },
        { type: 'source', name: 'Camera 2' },
      ]),
    );
  });
});
