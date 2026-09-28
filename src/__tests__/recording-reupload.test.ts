/**
 * Deactivate must upload and register only the recordings of the activation
 * that is ending. Strom never deletes recorder output, so files from earlier
 * activations of the same production are still in its media directory; they
 * were uploaded (and registered as RecordingDocs) once already.
 *
 * CouchDB, Strom and object storage are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockRecordingInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getRecordingsDb: () => ({ insert: mockRecordingInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet }),
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

// Strom's media directory after three activations of prod-rec-1, each of which
// wrote one segment: one from before per-activation directories, then act-1 and
// act-2. `list` returns the direct children of a directory.
const mediaFiles = [
  'recordings/prod-rec-1/prod-rec-1_20260927_090000_00000.mp4',
  'recordings/prod-rec-1/act-1/prod-rec-1_20260927_101500_00000.mp4',
  'recordings/prod-rec-1/act-2/prod-rec-1_20260927_110000_00000.mp4',
];
function listMedia(dir: string) {
  const entries = new Map<string, { name: string; path: string; is_dir: boolean }>();
  for (const file of mediaFiles) {
    if (!file.startsWith(`${dir}/`)) continue;
    const [name, ...rest] = file.slice(dir.length + 1).split('/');
    entries.set(name!, { name: name!, path: `${dir}/${name}`, is_dir: rest.length > 0 });
  }
  return Promise.resolve({ entries: [...entries.values()] });
}
const mockMediaList = vi.fn(listMedia);

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    recorder = { splitNow: vi.fn().mockResolvedValue({}) };
    media = { list: mockMediaList };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

import { buildServer } from '../server.js';
import { config } from '../config.js';

function makeActiveProduction() {
  return {
    _id: 'prod-rec-1',
    _rev: '3-abc',
    type: 'production',
    name: 'Rec Production',
    status: 'active',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    stromFlowId: 'flow-2',
    recorderBlockId: 'b-out-rec-1',
    recorderOutputDir: 'recordings/prod-rec-1/act-2',
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:59:00.000Z',
  };
}

const savedConfig = {
  minioEndpoint: config.minioEndpoint,
  minioAccessKey: config.minioAccessKey,
  minioSecretKey: config.minioSecretKey,
  minioBucket: config.minioBucket,
};

const putKeys: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  putKeys.length = 0;
  Object.assign(config, {
    minioEndpoint: 'minio.local:9000',
    minioAccessKey: 'a',
    minioSecretKey: 'b',
    minioBucket: 'vod',
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      putKeys.push(decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/')));
      return new Response('', { status: 200 });
    }
    return new Response('mp4-bytes', { status: 200 });
  }));
  mockGet.mockResolvedValue(makeActiveProduction());
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-rec-1', rev: '4-def' });
  mockDeactivateStromFlow.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(config, savedConfig);
});

describe('deactivate — recording upload is scoped to the ending activation', () => {
  it('uploads and registers only the current activation\'s segments', async () => {
    mockRecordingInsert.mockResolvedValue({ ok: true });
    const app = await buildServer();

    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(putKeys).toEqual(['prod-rec-1/prod-rec-1_20260927_110000_00000.mp4']);
    const registered = mockRecordingInsert.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(registered).toEqual(['prod-rec-1/prod-rec-1_20260927_110000_00000.mp4']);
    // The directory is cleared with the rest of the activation state.
    expect(mockInsert.mock.calls[0]![0].recorderOutputDir).toBeUndefined();
  });

  it('falls back to the shared directory for a production activated before per-activation directories', async () => {
    const { recorderOutputDir: _omit, ...legacy } = makeActiveProduction();
    mockGet.mockResolvedValue(legacy);
    mockRecordingInsert.mockResolvedValue({ ok: true });
    const app = await buildServer();

    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(mockMediaList).toHaveBeenCalledWith('recordings/prod-rec-1');
  });

  it('a retried deactivate does not register the same object twice', async () => {
    // First attempt uploads and registers, then Strom teardown fails, so the
    // production doc keeps its activation state and the operator retries.
    const stored = new Set<string>();
    mockRecordingInsert.mockImplementation(async (doc: { _id: string }) => {
      if (stored.has(doc._id)) throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
      stored.add(doc._id);
      return { ok: true };
    });
    mockDeactivateStromFlow.mockRejectedValueOnce(new Error('strom down'));
    const app = await buildServer();

    const first = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });
    const second = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(200);
    expect(mockRecordingInsert).toHaveBeenCalledTimes(2);
    expect(stored.size).toBe(1);
  });
});
