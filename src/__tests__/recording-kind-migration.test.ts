/**
 * `migration:recording-kind-v1` (OL-32a, spec iso-input-recording.md §3.4):
 * every RecordingDoc without `kind` is backfilled to `kind: 'program'`, through
 * findTrusted with a literal `$exists` selector; idempotent, resumable after a
 * failed write, and skipped once the instance marker exists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

let recordings: Array<Record<string, unknown>> = [];
let migrationMarker: Record<string, unknown> | null = null;
const rejectInsertIds = new Set<string>();
const mockFindTrusted = vi.fn();
const mockFind = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  isDbConnected: () => true,
  getRecordingsDb: () => ({ find: mockFind, findTrusted: mockFindTrusted, insert: mockInsert }),
  getMigrationStateDb: () => ({
    get: () =>
      migrationMarker
        ? Promise.resolve(migrationMarker)
        : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
    insert: (doc: Record<string, unknown>) => { migrationMarker = doc; return Promise.resolve({ ok: true }); },
  }),
}));

const { migrateRecordingKind } = await import('../services/migrate-recording-kind.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function rec(id: string, extra: Record<string, unknown> = {}) {
  return { _id: id, _rev: '1-a', type: 'recording', productionId: 'p', bucket: 'b', key: `p/${id}.mp4`, startedAt: '', createdAt: '', updatedAt: '', ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  migrationMarker = null;
  rejectInsertIds.clear();
  recordings = [];
  // A CouchDB-like find: the selector's `$exists: false` on kind, honouring `limit`.
  mockFindTrusted.mockImplementation(async (q: { selector: Record<string, unknown>; limit?: number }) => {
    const docs = recordings.filter((d) => d['type'] === 'recording' && d['kind'] === undefined);
    return { docs: docs.slice(0, q.limit ?? 25) };
  });
  mockInsert.mockImplementation(async (doc: Record<string, unknown>) => {
    if (rejectInsertIds.has(doc['_id'] as string)) throw Object.assign(new Error('insert failed'), { statusCode: 500 });
    const i = recordings.findIndex((r) => r['_id'] === doc['_id']);
    recordings[i] = { ...doc, _rev: '2-b' };
    return { ok: true };
  });
});

describe('migrateRecordingKind', () => {
  it('sets kind program on every doc without one, leaves others alone, writes the marker', async () => {
    recordings = [
      ...Array.from({ length: 450 }, (_, i) => rec(`r${i}`)),
      rec('already-input', { kind: 'input' }),
    ];
    await migrateRecordingKind(log);
    expect(recordings.filter((r) => r['kind'] === undefined)).toEqual([]);
    expect(recordings.filter((r) => r['kind'] === 'program')).toHaveLength(450);
    expect(recordings.find((r) => r['_id'] === 'already-input')!['kind']).toBe('input');
    expect(mockInsert).toHaveBeenCalledTimes(450);
    expect(migrationMarker).toMatchObject({ _id: 'migration:recording-kind-v1', migratedCount: 450 });

    // The selector is a literal, through findTrusted only.
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockFindTrusted).toHaveBeenCalledWith(expect.objectContaining({
      selector: { type: 'recording', kind: { $exists: false } },
    }));
  });

  it('is idempotent: a second run is a no-op once the marker exists', async () => {
    recordings = [rec('a'), rec('b')];
    await migrateRecordingKind(log);
    mockInsert.mockClear();
    mockFindTrusted.mockClear();
    await migrateRecordingKind(log);
    expect(mockFindTrusted).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('resumes after a failed write without the marker, migrating only the remainder', async () => {
    recordings = [rec('a'), rec('b'), rec('c')];
    rejectInsertIds.add('b');
    await migrateRecordingKind(log);
    expect(migrationMarker).toBeNull();
    expect(recordings.map((r) => r['kind'])).toEqual(['program', undefined, undefined]);

    rejectInsertIds.clear();
    mockInsert.mockClear();
    await migrateRecordingKind(log);
    expect(recordings.map((r) => r['kind'])).toEqual(['program', 'program', 'program']);
    // 'a' was not written twice.
    expect(mockInsert.mock.calls.map((c) => (c[0] as { _id: string })._id)).toEqual(['b', 'c']);
    expect(migrationMarker).toMatchObject({ migratedCount: 2 });
  });

  it('skips without a marker when CouchDB is unreachable', async () => {
    mockFindTrusted.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await migrateRecordingKind(log);
    expect(migrationMarker).toBeNull();
  });
});
