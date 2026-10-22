/**
 * Idempotent RecordingDoc registration (issue #554, OL-31c): the id is derived
 * from bucket+key and registration is an upsert.
 */
import { describe, it, expect } from 'vitest';
import { recordingDocId, upsertRecordingDoc, type RecordingDocStore } from '../lib/recording-registry.js';
import type { RecordingDoc } from '../db/types.js';

/** In-memory stand-in with CouchDB's write rules: a write must carry the current `_rev`. */
function couchStore(): RecordingDocStore & { docs: Map<string, RecordingDoc> } {
  const docs = new Map<string, RecordingDoc>();
  let seq = 0;
  return {
    docs,
    async get(id) {
      const doc = docs.get(id);
      if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(doc);
    },
    async insert(doc) {
      const current = docs.get(doc._id);
      if (current ? doc._rev !== current._rev : doc._rev !== undefined) {
        throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
      }
      const rev = `${++seq}-x`;
      docs.set(doc._id, { ...structuredClone(doc), _rev: rev });
      return { ok: true, id: doc._id, rev };
    },
  };
}

function recording(fields: Partial<RecordingDoc> = {}): Omit<RecordingDoc, '_id' | '_rev'> {
  return {
    type: 'recording',
    productionId: 'prod-1',
    bucket: 'vod',
    key: 'prod-1/recording_20260301_100002_00000.mp4',
    sizeBytes: 100,
    startedAt: '2026-03-01T10:00:02.000Z',
    endedAt: '2026-03-01T10:10:02.000Z',
    createdAt: '2026-03-01T11:00:00.000Z',
    updatedAt: '2026-03-01T11:00:00.000Z',
    ...fields,
  };
}

describe('recordingDocId', () => {
  it('is deterministic and a valid, slash-free document id', () => {
    const id = recordingDocId('vod', 'prefix/prod-1/a.mp4');
    expect(id).toBe(recordingDocId('vod', 'prefix/prod-1/a.mp4'));
    expect(id).toMatch(/^recording-[0-9a-f]{32}$/);
  });

  it('differs per bucket and per key, including where the bucket/key split falls', () => {
    const ids = new Set([
      recordingDocId('vod', 'a.mp4'),
      recordingDocId('vod2', 'a.mp4'),
      recordingDocId('vod', 'b.mp4'),
      recordingDocId('a/b', 'c'),
      recordingDocId('a', 'b/c'),
    ]);
    expect(ids.size).toBe(5);
  });
});

describe('upsertRecordingDoc', () => {
  it('registering the same bucket+key twice leaves exactly one RecordingDoc', async () => {
    const store = couchStore();
    await upsertRecordingDoc(store, recording());
    await upsertRecordingDoc(store, recording({ sizeBytes: 200, updatedAt: '2026-03-02T09:00:00.000Z', createdAt: '2026-03-02T09:00:00.000Z' }));

    expect(store.docs.size).toBe(1);
    const doc = [...store.docs.values()][0];
    expect(doc._id).toBe(recordingDocId('vod', 'prod-1/recording_20260301_100002_00000.mp4'));
    // The latest upload wins, but the doc keeps its first registration time.
    expect(doc.sizeBytes).toBe(200);
    expect(doc.updatedAt).toBe('2026-03-02T09:00:00.000Z');
    expect(doc.createdAt).toBe('2026-03-01T11:00:00.000Z');
  });

  it('keeps distinct objects as distinct docs', async () => {
    const store = couchStore();
    await upsertRecordingDoc(store, recording());
    await upsertRecordingDoc(store, recording({ key: 'prod-1/recording_20260301_100002_00001.mp4' }));
    await upsertRecordingDoc(store, recording({ bucket: 'other' }));
    expect(store.docs.size).toBe(3);
  });

  it('retries when a concurrent writer updates the doc between read and write', async () => {
    const store = couchStore();
    await upsertRecordingDoc(store, recording());
    const realGet = store.get.bind(store);
    let raced = false;
    store.get = async (id) => {
      const doc = await realGet(id);
      if (!raced) {
        raced = true;
        await store.insert({ ...doc, sizeBytes: 150 }); // bumps _rev under us
      }
      return doc;
    };
    await upsertRecordingDoc(store, recording({ sizeBytes: 300 }));
    expect(store.docs.size).toBe(1);
    expect([...store.docs.values()][0].sizeBytes).toBe(300);
  });

  it('throws non-conflict errors', async () => {
    const store: RecordingDocStore = {
      get: async () => { throw new Error('unreachable'); },
      insert: async () => { throw Object.assign(new Error('down'), { statusCode: 503 }); },
    };
    await expect(upsertRecordingDoc(store, recording())).rejects.toThrow('down');
  });
});
