/**
 * Per-input recorders (ProductionSourceAssignment.record) through the production lifecycle.
 * Activate saves their ids and binds the recording index. Deactivate splits
 * every recorder, waits for the split files, stops the flow, uploads input
 * files and registers them with their mixerInput, and copies the activation's
 * sidecar to object storage without registering it as a recording.
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

const mockOpenIndex = vi.fn();
const mockBindIndex = vi.fn();
const mockCloseIndex = vi.fn();
vi.mock('../services/recording-index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/recording-index.js')>();
  return {
    ...actual,
    openRecordingIndex: (...args: [string]) => { mockOpenIndex(...args); return actual.openRecordingIndex(...args); },
    bindRecordingIndex: (...args: Parameters<typeof actual.bindRecordingIndex>) => {
      mockBindIndex(...args);
      return actual.bindRecordingIndex(...args);
    },
    closeRecordingIndex: (...args: Parameters<typeof actual.closeRecordingIndex>) => {
      mockCloseIndex(...args);
      return actual.closeRecordingIndex(...args);
    },
  };
});

const ACT_NAME = '20261001T100000Z-11111111-1111-4111-8111-111111111111';
const ACT_DIR = `recordings/prod-iso-1/${ACT_NAME}`;
const PROGRAM = `${ACT_DIR}/prod-iso-1_20261001_100000_00000.mp4`;
const INPUT_1 = `${ACT_DIR}/video_in_1/prod-iso-1_video_in_1_video_20261001_100000_00000.mp4`;
const INPUT_1_AUDIO = `${ACT_DIR}/video_in_1/prod-iso-1_video_in_1_audio_20261001_100000_00000.mp4`;
const INPUT_2 = `${ACT_DIR}/video_in_2/prod-iso-1_video_in_2_audio_20261001_100000_00000.mp4`;
const SIDECAR = `${ACT_DIR}/recordings.json`;

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
const mockFlowsStop = vi.fn();
const mockMediaUpload = vi.fn().mockResolvedValue({});
let emit: (event: unknown) => void = () => {};

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: mockFlowsGet, start: vi.fn(), stop: mockFlowsStop, delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
    media = { list: mockMediaList, deleteFile: mockMediaDeleteFile, deleteDirectory: mockMediaDeleteDirectory, upload: mockMediaUpload };
    connectWebSocket(onEvent: (event: unknown) => void, _onClose?: () => void, onOpen?: () => void) {
      emit = onEvent;
      queueMicrotask(() => onOpen?.());
      return () => {};
    }
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

import { buildServer } from '../server.js';
import { config } from '../config.js';
import { deactivateProduction } from '../services/idle-watchdog.js';
import { bindRecordingIndex, closeRecordingIndex, currentRecordingIndex, openRecordingIndex } from '../services/recording-index.js';

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
  mediaFiles = [PROGRAM, INPUT_1, INPUT_1_AUDIO, INPUT_2, SIDECAR];
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

afterEach(async () => {
  await closeRecordingIndex('prod-iso-1');
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

  describe('with the activation\'s recording index open', () => {
    const fileEvent = (blockId: string, n: number) => ({
      type: 'RecorderFileChanged',
      data: { flow_id: 'flow-1', block_id: blockId, filename: `${ACT_DIR}/${blockId}_0000${n}.mp4`, start_utc_us: (1_000 + n) * 1000 },
    });
    const sidecarFiles = () => {
      const body = JSON.parse(mockMediaUpload.mock.calls.at(-1)![2] as string) as {
        program: { files: Array<{ path: string; startMs?: number }> };
        inputs: Record<string, { tracks: Record<string, { files: Array<{ path: string; startMs?: number }> }> }>;
      };
      return [body.program, ...Object.values(body.inputs).flatMap((i) => Object.values(i.tracks))].flatMap((r) => r.files);
    };
    const recorders = ['b-out-rec', 'b-inrec-v-1', 'b-inrec-a-1', 'b-inrec-a-2'];
    const splitOpened: string[] = [];

    beforeEach(async () => {
      const handle = await openRecordingIndex('prod-iso-1');
      bindRecordingIndex(handle, {
        productionId: 'prod-iso-1', productionName: 'ISO Production', flowId: 'flow-1', dir: ACT_DIR, activatedAtMs: 0,
        program: { recorderBlockId: 'b-out-rec', outputDir: ACT_DIR },
        inputs: [
          { mixerInput: 'video_in_1', blockIds: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' }, outputDir: `${ACT_DIR}/video_in_1`, sourceId: 'Whip', sourceName: 'WHIP', streamType: 'whip', recordMode: 'transcode' },
          { mixerInput: 'video_in_2', blockIds: { audio: 'b-inrec-a-2' }, outputDir: `${ACT_DIR}/video_in_2`, sourceId: 'Srt', sourceName: 'SRT', streamType: 'srt', recordMode: 'passthrough' },
        ],
      });
      for (const id of recorders) emit(fileEvent(id, 0));
      // A split opens the recorder's next file a moment after the request returns.
      splitOpened.length = 0;
      mockSplitNow.mockImplementation(async (_flowId: string, blockId: string) => {
        setTimeout(() => {
          splitOpened.push(blockId);
          emit(fileEvent(blockId, 1));
        }, 5);
      });
    });

    afterEach(() => {
      mockSplitNow.mockReset().mockResolvedValue({});
    });

    it('stops the flow once every split has opened its next file, before uploading', async () => {
      let openedAtStop: string[] = [];
      let uploadedAtStop = -1;
      mockFlowsStop.mockImplementationOnce(async () => {
        openedAtStop = [...splitOpened];
        uploadedAtStop = puts.size;
        return {};
      });
      await deactivate();
      expect(mockFlowsStop).toHaveBeenCalledWith('flow-1');
      expect(openedAtStop.sort()).toEqual([...recorders].sort());
      expect(uploadedAtStop).toBe(0);
      expect(puts.size).toBeGreaterThan(0);
      expect(mockFlowsStop.mock.invocationCallOrder[0]).toBeLessThan(mockDeactivateStromFlow.mock.invocationCallOrder[0]!);
    });

    it('lists the files the final split opened, with their startMs, in the sidecar it uploads', async () => {
      await deactivate();
      const files = sidecarFiles();
      for (const id of recorders) expect(files).toContainEqual({ path: `${ACT_DIR}/${id}_00001.mp4`, openedAtMs: expect.any(Number), startMs: 1_001 });
      expect(mockCloseIndex.mock.invocationCallOrder[0]).toBeGreaterThan(mockFlowsStop.mock.invocationCallOrder[0]!);
      expect(puts.get(`prod-iso-1/${ACT_NAME}/recordings.json`)).toBe('application/json');
    });

    it('closes only its own activation\'s index', async () => {
      // A reactivation during the upload opens the production's next index.
      let next: Awaited<ReturnType<typeof openRecordingIndex>> | undefined;
      mockMediaList.mockImplementationOnce(async (dir: string) => {
        next = await openRecordingIndex('prod-iso-1');
        return mockMediaList(dir);
      });
      await deactivate();
      expect(next).toBeDefined();
      expect(currentRecordingIndex('prod-iso-1')).toBe(next);
    });
  });

  it('writes the sidecar a last time when the idle timer ends the production', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await deactivateProduction('prod-iso-1', log as never);
    expect(mockCloseIndex).toHaveBeenCalledWith('prod-iso-1');
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

  it('copies the sidecar to object storage without registering it as a recording', async () => {
    await deactivate();
    expect(puts.get(`prod-iso-1/${ACT_NAME}/recordings.json`)).toBe('application/json');
    expect([...recordings.values()].some((d) => String(d['key']).endsWith('.json'))).toBe(false);
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
    mediaFiles = [INPUT_1, SIDECAR];
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
    expect(mediaFiles).toHaveLength(5);
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

  it('saves the input recorder ids and binds the recording index to the activation', async () => {
    mockFlowsGet.mockResolvedValue({ flow: { running: true, blocks: [] } });
    await activate();
    await vi.waitFor(() => expect(production['status']).toBe('active'));
    expect(production['inputRecorderBlockIds']).toEqual({ video_in_1: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' } });
    expect(mockOpenIndex).toHaveBeenCalledWith('prod-iso-1');
    expect(mockBindIndex).toHaveBeenCalledOnce();
    expect(mockBindIndex.mock.calls[0]![1]).toMatchObject({
      flowId: 'flow-new',
      dir: ACT_DIR,
      program: null,
      inputs: [{ mixerInput: 'video_in_1', blockIds: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' }, sourceId: 'Whip', recordMode: 'transcode' }],
    });
    expect(mockCloseIndex).not.toHaveBeenCalledWith(expect.objectContaining({ productionId: 'prod-iso-1' }));
  });

  it('closes the recording index and clears the ids when activation fails', async () => {
    mockFlowsGet.mockRejectedValue(new Error('strom unavailable'));
    await activate();
    await vi.waitFor(() => expect(production['status']).toBe('inactive'));
    await vi.waitFor(() => expect(mockCloseIndex).toHaveBeenCalledWith(expect.objectContaining({ productionId: 'prod-iso-1' })));
    expect(production['inputRecorderBlockIds']).toBeUndefined();
  });

  it('does not open a recording index when nothing is recorded', async () => {
    production = { ...production, sources: [{ sourceId: 'Whip', mixerInput: 'video_in_1', record: 'off' }] };
    mockActivateStromFlow.mockResolvedValue({ ...(await mockActivateStromFlow()), recordingsDir: undefined, inputRecorders: [] });
    mockFlowsGet.mockResolvedValue({ flow: { running: true, blocks: [] } });
    await activate();
    await vi.waitFor(() => expect(production['status']).toBe('active'));
    expect(mockOpenIndex).not.toHaveBeenCalled();
    expect(mockBindIndex).not.toHaveBeenCalled();
  });
});
