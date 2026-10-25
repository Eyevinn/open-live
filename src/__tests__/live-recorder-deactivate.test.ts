/**
 * OL-32a deactivate order (spec iso-input-recording.md §5.4):
 *  - Live Recorder: stop the flow first (the block finalises every open file
 *    inside the stop), then upload the program directory — no split-now;
 *  - builtin.recorder (fallback, and productions activated before OL-32a):
 *    unchanged — split-now, then upload, then the flow teardown.
 * Every RecordingDoc carries `kind: 'program'`, and this activation's parts the
 * `recorderType` that wrote them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockFindTrusted = vi.fn();
const mockOutputGet = vi.fn();
const mockRecordingInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, findTrusted: mockFindTrusted }),
  getOutputsDb: () => ({ get: mockOutputGet, insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getRecordingsDb: () => ({ insert: mockRecordingInsert }),
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

/** Every Strom-facing step, in call order. */
const calls: string[] = [];
const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

const mockSplitNow = vi.fn();
const mockFlowStop = vi.fn();
const mockMediaList = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: mockFlowStop, delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
    media = { list: mockMediaList, deleteFile: vi.fn().mockResolvedValue({}), deleteDirectory: vi.fn().mockResolvedValue({}) };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

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

const FILE = 'prod-lr-1_20261025_100000_00000.mp4';

function prod(recorderType?: 'liverecorder' | 'recorder') {
  return {
    _id: 'prod-lr-1', _rev: '3-abc', type: 'production', name: 'P', status: 'active',
    sources: [], pipeline: { stromConfig: null, status: 'running' }, graphics: [], macros: [],
    tally: { pgm: null, pvw: null }, stromFlowId: 'flow-lr', recorderBlockId: 'b-out-rec-1',
    ...(recorderType ? { recorderType } : {}),
    recording: { outputId: 'output-rec', startedAt: '2026-10-25T10:00:00.000Z' },
    outputAssignments: [{ outputId: 'output-rec', id: 'oa-1' }],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-25T10:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  setStorage(STORAGE);
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-lr-1', rev: '4-def' });
  mockOutputGet.mockResolvedValue({ _id: 'output-rec', outputType: 'recording' });
  mockDeactivateStromFlow.mockImplementation(async () => { calls.push('deactivateStromFlow'); });
  mockSplitNow.mockImplementation(async () => { calls.push('splitNow'); });
  mockFlowStop.mockImplementation(async () => { calls.push('flows.stop'); return {}; });
  mockRecordingInsert.mockResolvedValue({ ok: true });
  mockMediaList.mockImplementation(async () => {
    calls.push('media.list');
    return { entries: [{ name: FILE, path: `recordings/prod-lr-1/${FILE}`, is_dir: false }] };
  });
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
  const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-lr-1/deactivate' });
  return res.statusCode;
}

describe('deactivate — Live Recorder path (OL-32a, spec §5.4)', () => {
  it('stops the flow before uploading and never calls split-now', async () => {
    mockGet.mockResolvedValue(prod('liverecorder'));
    expect(await deactivate()).toBe(200);
    expect(mockSplitNow).not.toHaveBeenCalled();
    expect(mockFlowStop).toHaveBeenCalledWith('flow-lr');
    expect(calls).toEqual(['flows.stop', 'media.list', 'deactivateStromFlow']);
  });

  it('registers a leftover part (no live session) as program, from its file-name stamp', async () => {
    mockGet.mockResolvedValue(prod('liverecorder'));
    await deactivate();
    const doc = mockRecordingInsert.mock.calls[0]![0] as Record<string, unknown>;
    expect(doc).toMatchObject({
      key: `prod-lr-1/${FILE}`,
      kind: 'program',
      startedAt: '2026-10-25T10:00:00.000Z',
      startedAtSource: 'filename',
    });
    // Not known to be this activation's, so not known to be Live Recorder's.
    expect(doc['activationId']).toBeUndefined();
    expect(doc['recorderType']).toBeUndefined();
  });

  it("takes this activation's last part start from the live session's open time, even with RECORDING_SEGMENT_SECS=0", async () => {
    const segmentSecs = config.recordingSegmentSecs;
    (config as { recordingSegmentSecs: number }).recordingSegmentSecs = 0;
    try {
      let socket: RecorderSocketHandlers | undefined;
      setRecorderSocketFactory(async (h) => { socket = h; return () => {}; });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      startLiveRecordingUpload(prod('liverecorder'), log);
      await vi.waitFor(() => expect(socket).toBeDefined());
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-25T10:00:00.420Z'));
      socket!.onEvent({
        type: 'RecorderFileChanged',
        data: { flow_id: 'flow-lr', block_id: 'b-out-rec-1', filename: `recordings/prod-lr-1/${FILE}` },
      });
      now.mockRestore();

      mockGet.mockResolvedValue(prod('liverecorder'));
      expect(await deactivate()).toBe(200);
      expect(mockRecordingInsert).toHaveBeenCalledWith(expect.objectContaining({
        key: `prod-lr-1/${FILE}`,
        kind: 'program',
        recorderType: 'liverecorder',
        activationId: 'flow-lr',
        startedAt: '2026-10-25T10:00:00.420Z',
        startedAtSource: 'event',
      }));
      expect(mockSplitNow).not.toHaveBeenCalled();
    } finally {
      (config as { recordingSegmentSecs: number }).recordingSegmentSecs = segmentSecs;
    }
  });

  it('still uploads when the pre-upload stop fails', async () => {
    mockGet.mockResolvedValue(prod('liverecorder'));
    mockFlowStop.mockRejectedValueOnce(new Error('Strom 502'));
    expect(await deactivate()).toBe(200);
    expect(mockRecordingInsert).toHaveBeenCalledTimes(1);
    expect(mockSplitNow).not.toHaveBeenCalled();
  });
});

describe('deactivate — builtin.recorder path is unchanged (OL-32a, AC 8)', () => {
  it.each([
    ['recorder', 'recorder' as const],
    ['absent (activated before OL-32a)', undefined],
  ])('recorderType %s: split-now, then upload, then teardown; no early stop', async (_label, type) => {
    mockGet.mockResolvedValue(prod(type));
    expect(await deactivate()).toBe(200);
    expect(mockSplitNow).toHaveBeenCalledWith('flow-lr', 'b-out-rec-1');
    expect(mockFlowStop).not.toHaveBeenCalled();
    expect(calls).toEqual(['splitNow', 'media.list', 'deactivateStromFlow']);
    expect(mockRecordingInsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'program' }));
  });

  it('clears recorderType on the deactivated doc', async () => {
    mockGet.mockResolvedValue(prod('liverecorder'));
    await deactivate();
    const written = mockInsert.mock.calls.map((c) => c[0] as Record<string, unknown>).find((d) => d['_id'] === 'prod-lr-1');
    expect(written).toBeDefined();
    expect(written!['recorderType']).toBeUndefined();
    expect(written!['recorderBlockId']).toBeUndefined();
  });
});
