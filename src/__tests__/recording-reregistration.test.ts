/**
 * A file uploaded once whose Strom delete then fails stays on Strom, so the
 * next deactivate sweeps and uploads it again. It must still be listed exactly
 * once (issue #554, OL-31c): the RecordingDoc id is derived from bucket+key and
 * registration is an upsert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RecordingDoc } from '../db/types.js';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockFindTrusted = vi.fn();
const mockOutputGet = vi.fn();

// In-memory recordings store with CouchDB's rules: inserting an existing id
// without its current _rev is a 409 conflict.
const recordings = new Map<string, RecordingDoc>();
let revSeq = 0;
const recordingsDb = {
  get: vi.fn(async (id: string) => {
    const doc = recordings.get(id);
    if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return { ...doc };
  }),
  insert: vi.fn(async (doc: RecordingDoc) => {
    const current = recordings.get(doc._id);
    if (current ? doc._rev !== current._rev : doc._rev !== undefined) {
      throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
    }
    const rev = `${++revSeq}-r`;
    recordings.set(doc._id, { ...doc, _rev: rev });
    return { ok: true, id: doc._id, rev };
  }),
};

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, findTrusted: mockFindTrusted }),
  getOutputsDb: () => ({ get: mockOutputGet, insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getRecordingsDb: () => recordingsDb,
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }), insert: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
}));

const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

const mockSplitNow = vi.fn();
const mockMediaList = vi.fn();
const mockDeleteFile = vi.fn();
const mockDeleteDir = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
    media = { list: mockMediaList, deleteFile: mockDeleteFile, deleteDirectory: mockDeleteDir };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

import { buildServer } from '../server.js';
import { config } from '../config.js';

const STORAGE = {
  minioEndpoint: 'http://minio.local:9000',
  minioAccessKey: 'AKIAEXAMPLE',
  minioSecretKey: 'secretexamplekey',
  minioBucket: 'openlive-vod',
} as const;
function setStorage(values: Partial<Record<keyof typeof STORAGE, string | undefined>>): void {
  for (const key of Object.keys(STORAGE) as Array<keyof typeof STORAGE>) {
    (config as Record<string, unknown>)[key] = values[key];
  }
}

function prod() {
  return {
    _id: 'prod-rec-1', _rev: '3-abc', type: 'production', name: 'P', status: 'active',
    sources: [], pipeline: { stromConfig: null, status: 'running' }, graphics: [], macros: [],
    tally: { pgm: null, pvw: null }, stromFlowId: 'flow-rec', recorderBlockId: 'recorder-1',
    outputAssignments: [{ outputId: 'output-rec', id: 'oa-1' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z',
  };
}
const FILE = 'recording_20260301_100002_00000.mp4';
const KEY = `prod-rec-1/${FILE}`;

beforeEach(() => {
  vi.clearAllMocks();
  recordings.clear();
  setStorage(STORAGE);
  mockGet.mockResolvedValue(prod());
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-rec-1', rev: '4-def' });
  mockOutputGet.mockResolvedValue({ _id: 'output-rec', outputType: 'recording' });
  mockDeactivateStromFlow.mockResolvedValue(undefined);
  mockSplitNow.mockResolvedValue(undefined);
  mockDeleteDir.mockResolvedValue({});
  mockMediaList.mockResolvedValue({
    entries: [{ name: FILE, path: `recordings/prod-rec-1/${FILE}`, is_dir: false }],
  });
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return new Response('', { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }));
});
afterEach(() => { setStorage({}); vi.unstubAllGlobals(); });

describe('deactivate — a file left on Strom after upload is registered once (issue #554)', () => {
  it('lists the file exactly once after it is swept again by the next deactivate', async () => {
    // The Strom delete fails, so the uploaded file stays for the next sweep.
    mockDeleteFile.mockRejectedValue(new Error('strom delete failed'));
    const app = await buildServer();

    const first = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });
    expect(first.statusCode).toBe(200);
    expect(recordings.size).toBe(1);
    const firstDoc = [...recordings.values()][0];

    const second = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });
    expect(second.statusCode).toBe(200);

    // Both sweeps uploaded and registered the same object…
    expect(mockDeleteFile).toHaveBeenCalledTimes(2);
    // …and it is still listed exactly once, updated in place.
    const docs = [...recordings.values()];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ _id: firstDoc._id, bucket: 'openlive-vod', key: KEY, createdAt: firstDoc.createdAt });
    expect(docs[0]._rev).not.toBe(firstDoc._rev);
  });
});
