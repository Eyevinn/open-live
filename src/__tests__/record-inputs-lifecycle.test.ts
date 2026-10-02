/**
 * Per-input recorders (ProductionSourceAssignment.record) through the production lifecycle.
 * Activate saves their ids. Deactivate splits every recorder, and uploads
 * input files and registers them with their mixerInput.
 *
 * CouchDB, Strom and object storage are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Doc = Record<string, unknown> & { _id: string };

let production: Doc;
const recordings = new Map<string, Doc>();
const notFound = () => Object.assign(new Error('missing'), { statusCode: 404 });

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async () => ({ ...production })),
    insert: vi.fn(async (doc: Doc) => {
      production = JSON.parse(JSON.stringify(doc));
      return { ok: true, id: doc._id, rev: 'n' };
    }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getOutputsDb: () => ({ get: vi.fn(async () => ({ _id: 'output-rec', outputType: 'recording' })), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = recordings.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    insert: vi.fn(async (doc: Doc) => {
      recordings.set(doc._id, doc);
      return { ok: true };
    }),
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
  reinitConnectedControllers: vi.fn(),
}));

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));


const ACT_NAME = '20261001T100000Z-11111111-1111-4111-8111-111111111111';
const ACT_DIR = `recordings/prod-iso-1/${ACT_NAME}`;
const PROGRAM = `${ACT_DIR}/prod-iso-1_20261001_100000_00000.mp4`;
const INPUT_1 = `${ACT_DIR}/video_in_1/prod-iso-1_video_in_1_video_20261001_100000_00000.mp4`;
const INPUT_1_AUDIO = `${ACT_DIR}/video_in_1/prod-iso-1_video_in_1_audio_20261001_100000_00000.mp4`;
const INPUT_2 = `${ACT_DIR}/video_in_2/prod-iso-1_video_in_2_audio_20261001_100000_00000.mp4`;

let mediaFiles: string[];
const mockMediaList = vi.fn(async (dir: string) => {
  const { StromClientError } = await import('../lib/strom.js');
  const entries = new Map<string, { name: string; path: string; is_directory: boolean; modified: number }>();
  for (const file of mediaFiles) {
    if (!file.startsWith(`${dir}/`)) continue;
    const [name, ...rest] = file.slice(dir.length + 1).split('/');
    entries.set(name!, { name: name!, path: `${dir}/${name}`, is_directory: rest.length > 0, modified: 0 });
  }
  if (entries.size === 0) throw new StromClientError(404, 'Directory not found');
  return { entries: [...entries.values()] };
});
const mockMediaDeleteFile = vi.fn(async (path: string) => {
  mediaFiles = mediaFiles.filter((f) => f !== path);
  return { success: true };
});
const deletedDirs: string[] = [];
const mockMediaDeleteDirectory = vi.fn(async (dir: string) => {
  if (mediaFiles.some((f) => f.startsWith(`${dir}/`))) throw new Error('Directory not empty');
  deletedDirs.push(dir);
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

const savedConfig = {
  minioEndpoint: config.minioEndpoint,
  minioAccessKey: config.minioAccessKey,
  minioSecretKey: config.minioSecretKey,
  minioBucket: config.minioBucket,
};
const puts = new Map<string, string>();

function activeProduction(overrides: Record<string, unknown> = {}): Doc {
  return {
    _id: 'prod-iso-1',
    _rev: '3-abc',
    type: 'production',
    name: 'ISO Production',
    status: 'active',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    stromFlowId: 'flow-1',
    recorderBlockId: 'b-out-rec',
    recorderOutputDir: ACT_DIR,
    inputRecorderBlockIds: { video_in_1: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' }, video_in_2: { audio: 'b-inrec-a-2' } },
    outputAssignments: [{ outputId: 'output-rec' }],
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

async function deactivate() {
  const app = await buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-iso-1/deactivate' });
  expect(res.statusCode).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  recordings.clear();
  puts.clear();
  deletedDirs.length = 0;
  mediaFiles = [PROGRAM, INPUT_1, INPUT_1_AUDIO, INPUT_2];
  production = activeProduction();
  mockDeactivateStromFlow.mockResolvedValue(undefined);
  Object.assign(config, { minioEndpoint: 'minio.local:9000', minioAccessKey: 'a', minioSecretKey: 'b', minioBucket: 'vod' });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const key = decodeURIComponent(new URL(url).pathname.split('/').slice(2).join('/'));
      puts.set(key, (init.headers as Record<string, string>)['Content-Type']!);
      return new Response('', { status: 200 });
    }
    return new Response('bytes', { status: 200 });
  }));
});

afterEach(() => {
  Object.assign(config, savedConfig);
  vi.unstubAllGlobals();
});

describe('deactivate — per-input recordings', () => {
  it('splits the program and every input recorder before uploading', async () => {
    await deactivate();
    expect(mockSplitNow.mock.calls.map((c) => c[1]).sort()).toEqual(['b-inrec-a-1', 'b-inrec-a-2', 'b-inrec-v-1', 'b-out-rec']);
    expect(mockSplitNow.mock.calls.every((c) => c[0] === 'flow-1')).toBe(true);
    expect(mockDeactivateStromFlow).toHaveBeenCalledOnce();
  });

  it('registers input files with their mixerInput and the program file with its output', async () => {
    await deactivate();
    const docs = [...recordings.values()].map((d) => ({ key: d['key'], mixerInput: d['mixerInput'], track: d['track'], outputId: d['outputId'] }));
    expect(docs).toEqual(expect.arrayContaining([
      { key: 'prod-iso-1/prod-iso-1_20261001_100000_00000.mp4', mixerInput: undefined, track: undefined, outputId: 'output-rec' },
      { key: 'prod-iso-1/prod-iso-1_video_in_1_video_20261001_100000_00000.mp4', mixerInput: 'video_in_1', track: 'video', outputId: undefined },
      { key: 'prod-iso-1/prod-iso-1_video_in_1_audio_20261001_100000_00000.mp4', mixerInput: 'video_in_1', track: 'audio', outputId: undefined },
      { key: 'prod-iso-1/prod-iso-1_video_in_2_audio_20261001_100000_00000.mp4', mixerInput: 'video_in_2', track: 'audio', outputId: undefined },
    ]));
    expect(docs).toHaveLength(4);
    expect([...recordings.values()].every((d) => d['startedAt'] === '2026-10-01T10:00:00.000Z')).toBe(true);
  });

  it('removes the uploaded files and the input directories before the activation directory', async () => {
    await deactivate();
    expect(mediaFiles).toEqual([]);
    expect(deletedDirs).toEqual([`${ACT_DIR}/video_in_1`, `${ACT_DIR}/video_in_2`, ACT_DIR]);
  });

  it('clears the input recorder ids', async () => {
    await deactivate();
    expect(production['inputRecorderBlockIds']).toBeUndefined();
  });

  it('sweeps input recordings when only inputs were recorded', async () => {
    mediaFiles = [INPUT_1];
    production = activeProduction({ recorderBlockId: undefined, recorderOutputDir: undefined, outputAssignments: [] });
    await deactivate();
    expect(mockSplitNow.mock.calls.map((c) => c[1]).sort()).toEqual(['b-inrec-a-1', 'b-inrec-a-2', 'b-inrec-v-1']);
    expect([...recordings.values()].map((d) => d['mixerInput'])).toEqual(['video_in_1']);
  });

  it('keeps everything on Strom, without splitting, when object storage is not configured', async () => {
    Object.assign(config, { minioEndpoint: undefined, minioAccessKey: undefined, minioSecretKey: undefined, minioBucket: undefined });
    await deactivate();
    expect(mockSplitNow).not.toHaveBeenCalled();
    expect(puts.size).toBe(0);
    expect(mediaFiles).toHaveLength(4);
    expect(production['inputRecorderBlockIds']).toBeUndefined();
    expect(mockDeactivateStromFlow).toHaveBeenCalledOnce();
  });
});

describe('activate — per-input recorders', () => {
  const inputRecorders = [{
    mixerInput: 'video_in_1', blockIds: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' }, outputDir: `${ACT_DIR}/video_in_1`, recordMode: 'transcode',
    sourceId: 'Whip', sourceName: 'WHIP Input', streamType: 'whip',
  }];

  beforeEach(() => {
    production = activeProduction({
      status: 'inactive', stromFlowId: undefined, recorderBlockId: undefined, recorderOutputDir: undefined,
      inputRecorderBlockIds: undefined, outputAssignments: [],
      sources: [{ sourceId: 'Whip', mixerInput: 'video_in_1', record: 'transcode' }],
    });
    mockActivateStromFlow.mockResolvedValue({
      flowId: 'flow-new', mixerBlockId: null, audioMixerBlockId: null, loudnessMainBlockId: null,
      sourceOffsetBlockIds: {}, sourceAudioOffsetBlockIds: {}, clipPlayerBlockIds: {}, returnBuses: [], returnWhepEntries: [], mixerInputMap: {},
      warnings: [], recordingsDir: ACT_DIR, inputRecorders,
    });
  });

  async function activate() {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-iso-1/activate' });
    expect(res.statusCode).toBe(200);
  }

  it('saves the input recorder ids', async () => {
    mockFlowsGet.mockResolvedValue({ flow: { running: true, blocks: [] } });
    await activate();
    await vi.waitFor(() => expect(production['status']).toBe('active'));
    expect(production['inputRecorderBlockIds']).toEqual({ video_in_1: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' } });
  });

  it('clears the ids when activation fails', async () => {
    mockFlowsGet.mockRejectedValue(new Error('strom unavailable'));
    await activate();
    await vi.waitFor(() => expect(production['status']).toBe('inactive'));
    expect(production['inputRecorderBlockIds']).toBeUndefined();
  });

});
