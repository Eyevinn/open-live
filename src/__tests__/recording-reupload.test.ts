/**
 * Deactivate uploads each recording exactly once. A file can outlive its upload
 * on Strom (its delete failed, or was skipped because the production changed
 * mid-sweep), so later deactivates must skip already-registered files, and
 * pick up files whose upload failed earlier.
 *
 * CouchDB, Strom and object storage are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Doc = Record<string, unknown> & { _id: string };

// Stateful fakes: the production document and the registered RecordingDocs.
let production: Doc;
const productionWrites: Doc[] = [];
const recordings = new Map<string, Doc>();

const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 });

const mockRecordingInsert = vi.fn(async (doc: Doc) => {
  if (recordings.has(doc._id)) throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
  recordings.set(doc._id, doc);
  return { ok: true };
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async () => ({ ...production })),
    insert: vi.fn(async (doc: Doc) => {
      production = JSON.parse(JSON.stringify(doc));
      productionWrites.push(production);
      return { ok: true, id: doc._id, rev: 'n' };
    }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getOutputsDb: () => ({ get: vi.fn().mockRejectedValue(notFound()), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = recordings.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    insert: mockRecordingInsert,
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(notFound()) }),
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

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

// Strom's media directory for prod-rec-1: one segment written before
// per-activation directories, then one per activation directory.
const LEGACY = 'recordings/prod-rec-1/prod-rec-1_20260927_090000_00000.mp4';
const ACT1_DIR = 'recordings/prod-rec-1/20260927T100000Z-11111111-1111-4111-8111-111111111111';
const ACT2_DIR = 'recordings/prod-rec-1/20260927T110000Z-22222222-2222-4222-8222-222222222222';
const ACT1 = `${ACT1_DIR}/prod-rec-1_20260927_100000_00000.mp4`;
const ACT2 = `${ACT2_DIR}/prod-rec-1_20260927_110000_00000.mp4`;
const keyOf = (path: string) => `prod-rec-1/${path.split('/').pop()}`;

let mediaFiles: string[];
const mockMediaList = vi.fn(async (dir: string) => {
  const { StromClientError } = await import('../lib/strom.js');
  const entries = new Map<string, { name: string; path: string; is_directory: boolean; modified: number }>();
  for (const file of mediaFiles) {
    if (!file.startsWith(`${dir}/`)) continue;
    const [name, ...rest] = file.slice(dir.length + 1).split('/');
    // Last written a minute after the activation's hour.
    const modified = Date.parse(`2026-09-27T${name!.includes('_10') ? '10' : '11'}:01:00Z`) / 1000;
    entries.set(name!, { name: name!, path: `${dir}/${name}`, is_directory: rest.length > 0, modified });
  }
  if (entries.size === 0) throw new StromClientError(404, 'Directory not found');
  return { entries: [...entries.values()] };
});
const mockMediaDeleteFile = vi.fn(async (path: string) => {
  mediaFiles = mediaFiles.filter((f) => f !== path);
  return { success: true };
});
// Strom only deletes an empty directory.
const mockMediaDeleteDirectory = vi.fn(async (dir: string) => {
  if (mediaFiles.some((f) => f.startsWith(`${dir}/`))) throw new Error('Directory not empty');
  return { success: true };
});
const mockSplitNow = vi.fn().mockResolvedValue({});
const mockFlowsGet = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: mockFlowsGet, start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
    media = { list: mockMediaList, deleteFile: mockMediaDeleteFile, deleteDirectory: mockMediaDeleteDirectory };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

import { buildServer } from '../server.js';
import { config } from '../config.js';

function activeProduction(overrides: Record<string, unknown> = {}): Doc {
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
    recorderOutputDir: ACT2_DIR,
    createdAt: '2026-09-27T09:00:00.000Z',
    updatedAt: '2026-09-27T11:30:00.000Z',
    ...overrides,
  };
}

/** Registers a file as a previous deactivate would have. */
async function preRegister(path: string) {
  const { createHash } = await import('crypto');
  const key = keyOf(path);
  const id = `recording-${createHash('sha256').update(`vod/${key}`).digest('hex').slice(0, 32)}`;
  recordings.set(id, { _id: id, key });
}

const registered = () => [...recordings.values()] as unknown as Array<{ key: string; startedAt?: string; endedAt?: string }>;

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
  recordings.clear();
  productionWrites.length = 0;
  mediaFiles = [LEGACY, ACT1, ACT2];
  production = activeProduction();
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
  mockDeactivateStromFlow.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(config, savedConfig);
});

async function deactivate() {
  const app = await buildServer();
  return app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });
}

describe('deactivate — each recording is uploaded and registered once', () => {
  it('uploads the ending activation and skips recordings already registered', async () => {
    await preRegister(ACT1);

    const res = await deactivate();

    expect(res.statusCode).toBe(200);
    expect(putKeys).toEqual([keyOf(ACT2)]);
    expect(registered().map((r) => r.key)).toEqual([keyOf(ACT1), keyOf(ACT2)]);
    expect(production['recorderOutputDir']).toBeUndefined();
    expect(production['recorderBlockId']).toBeUndefined();
  });

  it('picks up an earlier activation whose upload failed, dated by that activation', async () => {
    const res = await deactivate();

    expect(res.statusCode).toBe(200);
    expect(putKeys).toEqual([keyOf(ACT1), keyOf(ACT2)]);
    const act1 = registered().find((r) => r.key === keyOf(ACT1))!;
    expect(act1.startedAt).toBe('2026-09-27T10:00:00.000Z');
    expect(act1.endedAt).toBe('2026-09-27T10:01:00.000Z');
    expect(registered().find((r) => r.key === keyOf(ACT2))!.startedAt).toBe('2026-09-27T11:00:00.000Z');
  });

  it('uploads files in the production directory itself only for a production activated before per-activation directories', async () => {
    await preRegister(ACT1);
    await preRegister(ACT2);
    production = activeProduction({ recorderOutputDir: undefined });

    await deactivate();

    expect(putKeys).toEqual([keyOf(LEGACY)]);
  });

  it('a retried deactivate uploads and registers nothing again', async () => {
    mockDeactivateStromFlow.mockRejectedValueOnce(new Error('strom down'));

    const first = await deactivate();
    const second = await deactivate();

    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(200);
    expect(putKeys).toEqual([keyOf(ACT1), keyOf(ACT2)]);
    expect(registered()).toHaveLength(2);
  });

  it('uploads a leftover activation even when this activation had no recorder', async () => {
    mediaFiles = [ACT1];
    production = activeProduction({ recorderBlockId: undefined, recorderOutputDir: undefined });

    const res = await deactivate();

    expect(res.statusCode).toBe(200);
    expect(mockSplitNow).not.toHaveBeenCalled();
    expect(putKeys).toEqual([keyOf(ACT1)]);
  });

  it('deletes every file in object storage from Strom, including ones registered earlier', async () => {
    await preRegister(ACT1);

    await deactivate();

    expect(putKeys).toEqual([keyOf(ACT2)]);
    expect(mediaFiles).toEqual([LEGACY]);
    expect(mockMediaDeleteDirectory.mock.calls.map(([dir]) => dir)).toEqual([ACT1_DIR, ACT2_DIR]);
  });

  it('keeps every file on Strom when the production changes during the sweep', async () => {
    const fetchMock = vi.mocked(fetch);
    const upload = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) => {
      // A reactivation writes the production while the upload is in flight.
      production = { ...production, _rev: '4-def' };
      return upload(url, init);
    });

    await deactivate();

    expect(putKeys).toEqual([keyOf(ACT1), keyOf(ACT2)]);
    expect(mediaFiles).toEqual([LEGACY, ACT1, ACT2]);
    expect(mockMediaDeleteFile).not.toHaveBeenCalled();
    expect(mockMediaDeleteDirectory).not.toHaveBeenCalled();
  });

  it('a production that never recorded uploads nothing', async () => {
    mediaFiles = [];
    production = activeProduction({ recorderBlockId: undefined, recorderOutputDir: undefined });

    const res = await deactivate();

    expect(res.statusCode).toBe(200);
    expect(putKeys).toEqual([]);
    expect(mockRecordingInsert).not.toHaveBeenCalled();
  });
});

describe('activate — recorder fields describe only the current activation', () => {
  function activation(overrides: Record<string, unknown>) {
    return {
      flowId: 'flow-3',
      mixerBlockId: null,
      audioMixerBlockId: null,
      loudnessMainBlockId: null,
      sourceOffsetBlockIds: {},
      sourceAudioOffsetBlockIds: {},
      clipPlayerBlockIds: {},
      returnBuses: [],
      warnings: [],
      ...overrides,
    };
  }

  async function activate() {
    // The flow never reports running, so the activation fails and resets.
    mockFlowsGet.mockRejectedValue(new Error('strom unavailable'));
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/activate' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(productionWrites.at(-1)?.['status']).toBe('inactive'));
    // The write that records the new Strom flow and its block ids.
    return productionWrites.find((d) => d['stromFlowId'] === 'flow-3')!;
  }

  it('saves the recorder directory, and clears it when the activation fails', async () => {
    production = activeProduction({ status: 'inactive', stromFlowId: undefined, recorderBlockId: undefined, recorderOutputDir: undefined });
    mockActivateStromFlow.mockResolvedValue(activation({ recorderBlockId: 'b-rec-3', recorderOutputDir: ACT2_DIR }));

    const flowSaved = await activate();

    expect(flowSaved['recorderOutputDir']).toBe(ACT2_DIR);
    expect(flowSaved['recorderBlockId']).toBe('b-rec-3');
    expect(production['recorderOutputDir']).toBeUndefined();
    expect(production['recorderBlockId']).toBeUndefined();
  });

  it('an activation without a recorder replaces recorder fields left by an earlier one', async () => {
    // Left behind by an activation that ended without the deactivate route.
    production = activeProduction({ status: 'inactive', stromFlowId: undefined });
    mockActivateStromFlow.mockResolvedValue(activation({}));

    const flowSaved = await activate();

    expect(flowSaved['recorderBlockId']).toBeUndefined();
    expect(flowSaved['recorderOutputDir']).toBeUndefined();
  });
});
