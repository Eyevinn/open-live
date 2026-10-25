/**
 * OL-32 per-source `record` opt-in (spec iso-input-recording.md §2.1-§2.3, §2.6):
 *  - POST /productions/:id/sources stores `record: 'transcode'`, stores `off` as
 *    absent, keeps replace semantics, refuses passthrough / unsupported sources /
 *    over the cap;
 *  - PUT /productions/:id/sources/:mixerInput/record toggles one assignment and
 *    reports appliesFrom / currentlyRecording / recordingOutputAssigned;
 *  - production responses strip the input recorders' internal fields.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProductionDoc } from '../db/types.js';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockSourceGet = vi.fn();
const mockOutputGet = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockSourceGet }),
  getOutputsDb: () => ({ get: mockOutputGet }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

import { buildServer } from '../server.js';
import { config as realConfig } from '../config.js';

const config = realConfig as { recordingMaxInputs: number };

const SOURCES: Record<string, { streamType: string; name: string }> = {
  'src-srt': { streamType: 'srt', name: 'Camera 1' },
  'src-efp': { streamType: 'efp', name: 'EFP' },
  'src-html': { streamType: 'html', name: 'Graphics' },
  'src-clip': { streamType: 'clip', name: 'Clip' },
};

function notFound(): Error {
  return Object.assign(new Error('missing'), { statusCode: 404, error: 'not_found' });
}

function makeProductionDoc(overrides: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    _id: 'prod-1',
    _rev: '1-abc',
    type: 'production',
    name: 'P',
    status: 'inactive',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let maxInputs: number;
beforeEach(() => {
  vi.clearAllMocks();
  maxInputs = config.recordingMaxInputs;
  config.recordingMaxInputs = 4;
  mockFind.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-1', rev: '2-new' });
  mockSourceGet.mockImplementation(async (id: string) => {
    const s = SOURCES[id];
    if (!s) throw notFound();
    return { _id: id, type: 'source', address: '', ...s };
  });
  mockOutputGet.mockImplementation(async (id: string) => {
    if (id === 'out-rec') return { _id: id, type: 'output', outputType: 'recording', name: 'Rec' };
    if (id === 'out-srt') return { _id: id, type: 'output', outputType: 'mpegtssrt', name: 'SRT' };
    throw notFound();
  });
});
afterEach(() => {
  config.recordingMaxInputs = maxInputs;
});

function lastInsertedDoc(): ProductionDoc {
  return mockInsert.mock.calls.at(-1)![0] as ProductionDoc;
}

async function inject(method: 'POST' | 'PUT' | 'GET', url: string, payload?: Record<string, unknown>) {
  const app = await buildServer();
  return app.inject({ method, url, ...(payload ? { payload } : {}) });
}

describe('POST /api/v1/productions/:id/sources — record (spec §2.2)', () => {
  it('leaves record absent by default', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', { sourceId: 'src-srt', mixerInput: 'video_in_1' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty('record');
    expect(lastInsertedDoc().sources[0]).toEqual({ sourceId: 'src-srt', mixerInput: 'video_in_1' });
  });

  it('stores record: transcode', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode', _rev: '2-new' });
    expect(lastInsertedDoc().sources[0]).toEqual({ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' });
  });

  it('accepts the virtual WHIP source', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'Whip', mixerInput: 'video_in_15', record: 'transcode',
    });
    expect(res.statusCode).toBe(201);
    expect(mockSourceGet).not.toHaveBeenCalled();
  });

  it("stores 'off' as absent", async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    await inject('POST', '/api/v1/productions/prod-1/sources', { sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'off' });
    expect(lastInsertedDoc().sources[0]).not.toHaveProperty('record');
  });

  it('a reassignment without record turns recording off (replace semantics)', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
    }));
    await inject('POST', '/api/v1/productions/prod-1/sources', { sourceId: 'src-efp', mixerInput: 'video_in_1' });
    expect(lastInsertedDoc().sources).toEqual([{ sourceId: 'src-efp', mixerInput: 'video_in_1' }]);
  });

  it('refuses passthrough with record-mode-unsupported', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'passthrough',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'record-mode-unsupported', statusCode: 400 });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each(['src-html', 'src-clip', '__test1__', 'src-missing'])('refuses %s with record-source-unsupported', async (sourceId) => {
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', { sourceId, mixerInput: 'video_in_1', record: 'transcode' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'record-source-unsupported' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('refuses over RECORDING_MAX_INPUTS with 409 record-cap-reached', async () => {
    config.recordingMaxInputs = 1;
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-efp', mixerInput: 'video_in_0', record: 'transcode' }],
    }));
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'record-cap-reached', statusCode: 409 });
  });

  it('re-sending the same recorded input does not count against the cap', async () => {
    config.recordingMaxInputs = 1;
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-efp', mixerInput: 'video_in_1', record: 'transcode' }],
    }));
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode',
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses every enable with RECORDING_MAX_INPUTS=0', async () => {
    config.recordingMaxInputs = 0;
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('POST', '/api/v1/productions/prod-1/sources', {
      sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'record-cap-reached' });
  });
});

describe('PUT /api/v1/productions/:id/sources/:mixerInput/record (spec §2.3)', () => {
  const url = '/api/v1/productions/prod-1/sources/video_in_1/record';

  it('turns recording on without touching the rest of the assignment', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [
        { sourceId: 'Whip', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus', lowLatency: false } },
        { sourceId: 'src-srt', mixerInput: 'video_in_2' },
      ],
      outputAssignments: [{ outputId: 'out-rec' }],
    }));
    const res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mixerInput: 'video_in_1',
      sourceId: 'Whip',
      record: 'transcode',
      appliesFrom: 'next-activation',
      currentlyRecording: false,
      recordingOutputAssigned: true,
      _rev: '2-new',
    });
    expect(lastInsertedDoc().sources).toEqual([
      { sourceId: 'Whip', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus', lowLatency: false }, record: 'transcode' },
      { sourceId: 'src-srt', mixerInput: 'video_in_2' },
    ]);
  });

  it('turns recording off by removing the field', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
    }));
    const res = await inject('PUT', url, { record: 'off' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ record: 'off', recordingOutputAssigned: false });
    expect(lastInsertedDoc().sources).toEqual([{ sourceId: 'src-srt', mixerInput: 'video_in_1' }]);
  });

  it('reports recordingOutputAssigned: false without a recording output', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1' }],
      outputAssignments: [{ outputId: 'out-srt' }],
    }));
    const res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ recordingOutputAssigned: false });
  });

  it('reports currentlyRecording from the running activation', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      status: 'active',
      sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
      inputRecordings: [{
        mixerInput: 'video_in_1', sourceId: 'src-srt', sourceName: 'Camera 1', streamType: 'srt',
        recorderBlockId: 'b-inrec-1-x', outputDir: 'recordings/prod-1/video_in_1',
      }],
    }));
    const res = await inject('PUT', url, { record: 'off' });
    // Still recording until the next activation (spec Q2).
    expect(res.json()).toMatchObject({ record: 'off', appliesFrom: 'next-activation', currentlyRecording: true });
  });

  it('setting off never fails for the cap or the source type', async () => {
    config.recordingMaxInputs = 0;
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [{ sourceId: 'src-html', mixerInput: 'video_in_1', record: 'transcode' }],
    }));
    const res = await inject('PUT', url, { record: 'off' });
    expect(res.statusCode).toBe(200);
  });

  it('404 for an unknown production or input', async () => {
    mockGet.mockRejectedValueOnce(notFound());
    expect((await inject('PUT', url, { record: 'transcode' })).statusCode).toBe(404);
    mockGet.mockResolvedValue(makeProductionDoc());
    const res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'Source assignment not found' });
  });

  it('400 for an invalid mixerInput or body', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    expect((await inject('PUT', '/api/v1/productions/prod-1/sources/dsk_in_0/record', { record: 'off' })).statusCode).toBe(400);
    expect((await inject('PUT', url, { record: 'maybe' })).statusCode).toBe(400);
    expect((await inject('PUT', url, {})).statusCode).toBe(400);
  });

  it('refuses passthrough, unsupported sources and over the cap', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({ sources: [{ sourceId: 'src-html', mixerInput: 'video_in_1' }] }));
    let res = await inject('PUT', url, { record: 'passthrough' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'record-mode-unsupported' });
    res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ reason: 'record-source-unsupported' });

    config.recordingMaxInputs = 1;
    mockGet.mockResolvedValue(makeProductionDoc({
      sources: [
        { sourceId: 'src-efp', mixerInput: 'video_in_0', record: 'transcode' },
        { sourceId: 'src-srt', mixerInput: 'video_in_1' },
      ],
    }));
    res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ reason: 'record-cap-reached' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('retries on a CouchDB 409', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({ sources: [{ sourceId: 'src-srt', mixerInput: 'video_in_1' }] }));
    mockInsert
      .mockRejectedValueOnce(Object.assign(new Error('conflict'), { statusCode: 409 }))
      .mockResolvedValueOnce({ ok: true, rev: '3-new' });
    const res = await inject('PUT', url, { record: 'transcode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ _rev: '3-new' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });
});

describe('production responses (spec §2.6)', () => {
  it('show inputRecordings without block ids or directories', async () => {
    mockGet.mockResolvedValue(makeProductionDoc({
      status: 'active',
      recorderType: 'liverecorder',
      inputRecordings: [{
        mixerInput: 'video_in_1', sourceId: 'src-srt', sourceName: 'Camera 1', streamType: 'srt',
        recorderBlockId: 'b-inrec-1-x', outputDir: 'recordings/prod-1/video_in_1',
      }],
    }));
    const res = await inject('GET', '/api/v1/productions/prod-1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recorderType: 'liverecorder',
      inputRecordings: [{ mixerInput: 'video_in_1', sourceId: 'src-srt', sourceName: 'Camera 1', streamType: 'srt' }],
    });
    expect(res.json().inputRecordings[0]).not.toHaveProperty('recorderBlockId');
    expect(res.json().inputRecordings[0]).not.toHaveProperty('outputDir');
  });
});
