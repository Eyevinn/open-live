/**
 * OL-32 deactivate with input recordings (spec iso-input-recording.md §5.4, AC 6):
 *  - Live Recorder path: stop the flow, then sweep every input directory —
 *    leftovers of earlier activations too — and then the program directory, so
 *    the program directory is empty when its sweep tries to delete it;
 *  - the last open part of every input is uploaded and registered with the
 *    input's metadata (from the live session) under `<pid>/<mixerInput>/`;
 *  - the deactivated doc clears inputRecordings, and RECORDING_STATE goes out
 *    with nothing recording before PRODUCTION_DEACTIVATED.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockRecordingInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }), findTrusted: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: vi.fn().mockResolvedValue({ _id: 'output-rec', outputType: 'recording' }), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getRecordingsDb: () => ({ insert: mockRecordingInsert }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }), get: vi.fn(), destroy: vi.fn() }),
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

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', async (orig) => {
  const actual = await orig<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, msg: Record<string, unknown>) => { broadcasts.push(msg); },
  };
});

const calls: string[] = [];
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(async () => { calls.push('deactivateStromFlow'); }),
}));

const listings: Record<string, Array<{ name: string; path: string; is_dir: boolean }>> = {};
/** Directories whose next listing fails. */
const failNextList = new Set<string>();
const mockDeleteFile = vi.fn();
const mockDeleteDirectory = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(async () => { calls.push('flows.stop'); return {}; }), delete: vi.fn() };
    recorder = { splitNow: vi.fn(async () => { calls.push('splitNow'); }) };
    media = {
      list: vi.fn(async (dir: string) => {
        calls.push(`list ${dir}`);
        if (failNextList.delete(dir)) throw new Error('Strom 502');
        return { entries: listings[dir] ?? [] };
      }),
      deleteFile: mockDeleteFile,
      deleteDirectory: mockDeleteDirectory,
    };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

import { buildServer } from '../server.js';
import { config } from '../config.js';
import { setRecorderSocketFactory, resetRecorderEvents, type RecorderSocketHandlers } from '../services/strom-recorder-events.js';
import { startLiveRecordingUpload, resetLiveRecordingUploads } from '../services/live-recording-upload.js';

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

const PROD = 'prod-iso';
const PGM_FILE = `${PROD}_20261101_180000_00000.mp4`;
const IN1_FILE = `${PROD}_video_in_1_20261101_180000_00000.mp4`;
const IN3_FILE = `${PROD}_video_in_3_20261031_120000_00004.mp4`; // leftover of an earlier activation

function file(dir: string, name: string) {
  return { name, path: `${dir}/${name}`, is_dir: false };
}

function prod(recorderType: 'liverecorder' | 'recorder' = 'liverecorder') {
  return {
    _id: PROD, _rev: '3-abc', type: 'production', name: 'P', status: 'active',
    sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
    pipeline: { stromConfig: null, status: 'running' }, graphics: [], macros: [],
    tally: { pgm: null, pvw: null }, stromFlowId: 'flow-iso', recorderBlockId: 'b-out-pgm', recorderType,
    recording: { outputId: 'output-rec', startedAt: '2026-11-01T18:00:00.000Z' },
    ...(recorderType === 'liverecorder'
      ? {
          inputRecordings: [{
            mixerInput: 'video_in_1', sourceId: 'src-srt', sourceName: 'Camera 1', streamType: 'srt',
            recorderBlockId: 'b-inrec-1', outputDir: `recordings/${PROD}/video_in_1`,
          }],
        }
      : {}),
    outputAssignments: [{ outputId: 'output-rec' }],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-11-01T18:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  broadcasts.length = 0;
  failNextList.clear();
  setStorage(STORAGE);
  for (const k of Object.keys(listings)) delete listings[k];
  listings[`recordings/${PROD}`] = [
    { name: 'video_in_3', path: `recordings/${PROD}/video_in_3`, is_dir: true },
    { name: 'video_in_1', path: `recordings/${PROD}/video_in_1`, is_dir: true },
    { name: 'not-an-input', path: `recordings/${PROD}/not-an-input`, is_dir: true },
    file(`recordings/${PROD}`, PGM_FILE),
  ];
  listings[`recordings/${PROD}/video_in_1`] = [file(`recordings/${PROD}/video_in_1`, IN1_FILE)];
  listings[`recordings/${PROD}/video_in_3`] = [file(`recordings/${PROD}/video_in_3`, IN3_FILE)];
  mockInsert.mockResolvedValue({ ok: true, id: PROD, rev: '4-def' });
  mockRecordingInsert.mockResolvedValue({ ok: true });
  mockDeleteFile.mockResolvedValue({});
  mockDeleteDirectory.mockResolvedValue({});
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return new Response('', { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }));
});
afterEach(() => {
  setStorage({});
  vi.unstubAllGlobals();
  resetLiveRecordingUploads();
  resetRecorderEvents();
  setRecorderSocketFactory(undefined);
});

async function deactivate(): Promise<number> {
  const app = await buildServer();
  const res = await app.inject({ method: 'POST', url: `/api/v1/productions/${PROD}/deactivate` });
  return res.statusCode;
}

const registered = () => mockRecordingInsert.mock.calls.map((c) => c[0] as Record<string, unknown>);

describe('deactivate with input recordings (spec §5.4)', () => {
  it('stops the flow, then sweeps every input directory by pad number, then program', async () => {
    mockGet.mockResolvedValue(prod());
    expect(await deactivate()).toBe(200);
    expect(calls).toEqual([
      'flows.stop',
      `list recordings/${PROD}`,
      `list recordings/${PROD}/video_in_1`,
      `list recordings/${PROD}/video_in_3`,
      `list recordings/${PROD}`,
      'deactivateStromFlow',
    ]);
    expect(registered().map((d) => d['key'])).toEqual([
      `${PROD}/video_in_1/${IN1_FILE}`,
      `${PROD}/video_in_3/${IN3_FILE}`,
      `${PROD}/${PGM_FILE}`,
    ]);
    // Each input directory is removed by its own sweep, before program's.
    expect(mockDeleteDirectory.mock.calls.map((c) => c[0])).toEqual([
      `recordings/${PROD}/video_in_1`,
      `recordings/${PROD}/video_in_3`,
      `recordings/${PROD}`,
    ]);
  });

  it("uploads the last open part of every input with the input's metadata (AC 6)", async () => {
    let socket: RecorderSocketHandlers | undefined;
    setRecorderSocketFactory(async (h) => { socket = h; return () => {}; });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    startLiveRecordingUpload(prod() as never, log);
    await vi.waitFor(() => expect(socket).toBeDefined());
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-01T18:00:00.300Z'));
    socket!.onEvent({
      type: 'RecorderFileChanged',
      data: { flow_id: 'flow-iso', block_id: 'b-inrec-1', filename: `recordings/${PROD}/video_in_1/${IN1_FILE}` },
    });
    now.mockRestore();

    mockGet.mockResolvedValue(prod());
    expect(await deactivate()).toBe(200);
    const docs = registered();
    expect(docs.find((d) => d['key'] === `${PROD}/video_in_1/${IN1_FILE}`)).toMatchObject({
      productionId: PROD,
      outputId: 'output-rec',
      kind: 'input',
      mixerInput: 'video_in_1',
      sourceId: 'src-srt',
      sourceName: 'Camera 1',
      streamType: 'srt',
      activationId: 'flow-iso',
      recorderType: 'liverecorder',
      startedAt: '2026-11-01T18:00:00.300Z',
      startedAtSource: 'event',
      partIndex: 0,
    });
    // A leftover only knows its directory.
    const leftover = docs.find((d) => d['key'] === `${PROD}/video_in_3/${IN3_FILE}`)!;
    expect(leftover).toMatchObject({ kind: 'input', mixerInput: 'video_in_3', partIndex: 4 });
    for (const k of ['sourceId', 'sourceName', 'activationId', 'recorderType']) expect(leftover).not.toHaveProperty(k);
    expect(docs.find((d) => d['key'] === `${PROD}/${PGM_FILE}`)).toMatchObject({ kind: 'program' });
  });

  it('sweeps leftover input directories on the builtin.recorder path too, after split-now', async () => {
    mockGet.mockResolvedValue(prod('recorder'));
    expect(await deactivate()).toBe(200);
    expect(calls[0]).toBe('splitNow');
    expect(registered().map((d) => d['key'])).toEqual([
      `${PROD}/video_in_1/${IN1_FILE}`,
      `${PROD}/video_in_3/${IN3_FILE}`,
      `${PROD}/${PGM_FILE}`,
    ]);
  });

  it('totals program and input files in lastRecordingUpload and clears inputRecordings', async () => {
    mockGet.mockResolvedValue(prod());
    await deactivate();
    const written = mockInsert.mock.calls.map((c) => c[0] as Record<string, unknown>).find((d) => d['_id'] === PROD)!;
    expect(written['inputRecordings']).toBeUndefined();
    expect(written['lastRecordingUpload']).toMatchObject({ uploaded: 3, failed: [] });
  });

  it('broadcasts RECORDING_STATE with nothing recording before PRODUCTION_DEACTIVATED', async () => {
    mockGet.mockResolvedValue(prod());
    await deactivate();
    const types = broadcasts.map((b) => b['type']);
    expect(broadcasts.find((b) => b['type'] === 'RECORDING_STATE')).toEqual({ type: 'RECORDING_STATE', program: false, inputs: [] });
    expect(types.indexOf('RECORDING_STATE')).toBeLessThan(types.indexOf('PRODUCTION_DEACTIVATED'));
  });

  it('still sweeps the directories this activation recorded when the parent listing fails', async () => {
    mockGet.mockResolvedValue(prod());
    failNextList.add(`recordings/${PROD}`);
    expect(await deactivate()).toBe(200);
    expect(registered().map((d) => d['key'])).toContain(`${PROD}/video_in_1/${IN1_FILE}`);
  });
});
