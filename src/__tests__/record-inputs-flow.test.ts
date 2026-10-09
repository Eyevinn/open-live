/**
 * Per-input recording (ProductionSourceAssignment.record): the flow generator
 * adds transcoding recorders for each opted-in arriving feed, and the source
 * assignment route validates the setting.
 *
 * Strom and CouchDB are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sourceDocs: Record<string, Record<string, unknown>> = {
  'src-srt': { _id: 'src-srt', type: 'source', name: 'Field cam', streamType: 'srt', address: 'srt://10.0.0.5:9000?mode=caller' },
};
const mockGet = vi.fn(async (id: string) => {
  if (sourceDocs[id]) return { ...sourceDocs[id] };
  throw new Error('not found');
});
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getOutputsDb: () => ({ get: mockGet }),
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

const ALL_BLOCKS = ['builtin.liverecorder', 'builtin.videoenc', 'builtin.audioenc'];

function makeStromClient(blockIds: string[] = ALL_BLOCKS) {
  const capturedFlows: Array<Record<string, unknown>> = [];
  return {
    blocks: { list: vi.fn().mockResolvedValue({ blocks: blockIds.map((id) => ({ id })) }) },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-1' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

type Mode = 'off' | 'transcode' | 'passthrough' | undefined;

/** Record modes for the test pattern, the WHIP slot and the SRT feed, in that order. */
function makeProduction([pattern, whip, srt]: Mode[]) {
  return {
    _id: 'prod-iso-1',
    type: 'production',
    name: 'ISO Production',
    status: 'inactive',
    sources: [
      { sourceId: '__test1__', mixerInput: 'video_in_0', record: pattern },
      { sourceId: 'Whip', mixerInput: 'video_in_1', record: whip },
      { sourceId: 'src-srt', mixerInput: 'video_in_2', record: srt },
    ],
    graphicAssignments: [],
    values: {},
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const recordingOutput = { _id: 'output-rec-abc12345', type: 'output', outputType: 'recording', name: 'VOD', createdAt: '', updatedAt: '' };

type Flow = { blocks: Array<Record<string, unknown>>; elements: Array<Record<string, unknown>>; links: Array<{ from: string; to: string }> };

const BOTH: Mode[] = [undefined, 'transcode', 'transcode'];

async function activate(record: Mode[], opts: { blocks?: string[]; outputs?: unknown[] } = {}) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient(opts.blocks);
  const result = await activateStromFlow(makeProduction(record) as never, strom as never, 'http://strom', opts.outputs as never);
  return { result, flow: strom.capturedFlows[0] as unknown as Flow, strom };
}

const linkFrom = (flow: Flow, to: string) => flow.links.find((l) => l.to === to)?.from;
const block = (flow: Flow, id: string) => flow.blocks.find((b) => b['id'] === id) ?? flow.elements.find((e) => e['id'] === id);
const props = (flow: Flow, id: string) => block(flow, id)?.['properties'] as Record<string, unknown>;

/** Walks back from a pad to the block feeding it: `${id}:${pad}` → producer id. */
const upstream = (flow: Flow, to: string) => linkFrom(flow, to)?.split(':')[0];

describe('flow-generator — per-input recording', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds transcoding recorders for each opted-in feed, tapped before the offset blocks', async () => {
    const { result, flow } = await activate(BOTH, { outputs: [recordingOutput] });

    expect(result.inputRecorders.map((r) => r.mixerInput)).toEqual(['video_in_1', 'video_in_2']);
    expect(result.recordingsDir).toBe(result.recorderOutputDir);

    for (const rec of result.inputRecorders) {
      const padIndex = rec.mixerInput.slice('video_in_'.length);
      const inputId = flow.blocks.find((b) => b['name'] === `${rec.mixerInput === 'video_in_1' ? 'WHIP' : 'SRT'} Input (V${padIndex})`)!['id'];
      expect(rec.outputDir).toBe(`${result.recordingsDir}/${rec.mixerInput}`);
      expect(rec.recordMode).toBe('transcode');

      // One recorder per track, so a track that never carries data cannot hold up the other.
      const video = rec.blockIds.video!;
      const audio = rec.blockIds.audio!;
      expect(props(flow, video)).toMatchObject({
        output_dir: rec.outputDir, filename_prefix: `prod-iso-1_${rec.mixerInput}_video`, num_video_tracks: 1, num_audio_tracks: 0,
      });
      expect(props(flow, audio)).toMatchObject({
        output_dir: rec.outputDir, filename_prefix: `prod-iso-1_${rec.mixerInput}_audio`, num_video_tracks: 0, num_audio_tracks: 1,
      });

      // video: input → leaky queue → H.264 encoder (2 s GOP) → recorder
      const venc = upstream(flow, `${video}:video_in_0`)!;
      expect(block(flow, venc)?.['block_definition_id']).toBe('builtin.videoenc');
      expect(props(flow, venc)).toMatchObject({ codec: 'h264', keyframe_interval: 60 });
      const vqueue = upstream(flow, `${venc}:video_in`)!;
      expect(block(flow, vqueue)).toMatchObject({ element_type: 'queue', properties: expect.objectContaining({ leaky: 'downstream' }) });
      expect(linkFrom(flow, `${vqueue}:sink`)).toBe(`${inputId}:video_out`);

      // audio: input → leaky queue → AAC encoder → recorder
      const aenc = upstream(flow, `${audio}:audio_in_0`)!;
      expect(props(flow, aenc)).toMatchObject({ codec: 'aac' });
      const aqueue = upstream(flow, `${aenc}:audio_in`)!;
      expect(block(flow, aqueue)).toMatchObject({ element_type: 'queue', properties: expect.objectContaining({ leaky: 'downstream' }) });
      expect(linkFrom(flow, `${aqueue}:sink`)).toBe(`${inputId}:${rec.mixerInput === 'video_in_1' ? 'audio_out' : 'audio_out_0'}`);
    }
  });

  it('lists each recorded input with its source', async () => {
    const { result } = await activate(BOTH);
    expect(result.inputRecorders).toEqual([
      expect.objectContaining({ mixerInput: 'video_in_1', sourceId: 'Whip', streamType: 'whip', recordMode: 'transcode' }),
      expect.objectContaining({ mixerInput: 'video_in_2', sourceId: 'src-srt', sourceName: 'Field cam', streamType: 'srt', recordMode: 'transcode' }),
    ]);
  });

  it('records only the inputs that opt in', async () => {
    const { result } = await activate([undefined, 'off', 'transcode']);
    expect(result.inputRecorders.map((r) => r.mixerInput)).toEqual(['video_in_2']);
    expect(result.warnings).toEqual([]);
  });

  it('records inputs without a recording output, in their own activation directory', async () => {
    const { result } = await activate(BOTH);
    expect(result.recorderBlockId).toBeUndefined();
    expect(result.recordingsDir).toMatch(/^recordings\/prod-iso-1\/\d{8}T\d{6}Z-[0-9a-f-]{36}$/);
    expect(result.inputRecorders).toHaveLength(2);
  });

  it.each([[[undefined, undefined, undefined]], [[undefined, 'off', 'off']]] as Mode[][][])(
    'adds no input recorder when no source opts in (%j)',
    async (record) => {
      const { result, flow } = await activate(record);
      expect(result.inputRecorders).toEqual([]);
      expect(result.recordingsDir).toBeUndefined();
      expect(result.warnings).toEqual([]);
      expect(flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.liverecorder')).toEqual([]);
    },
  );

  it('skips, with a warning, an input that is not an arriving feed', async () => {
    const { result } = await activate(['transcode', undefined, undefined]);
    expect(result.inputRecorders).toEqual([]);
    expect(result.warnings).toEqual([
      { type: 'input-recording-incomplete', message: expect.stringContaining('video_in_0 is not recorded') },
    ]);
  });

  it('skips, with a warning, an assignment saved with passthrough, which is not built yet', async () => {
    const { result } = await activate([undefined, 'transcode', 'passthrough']);
    expect(result.inputRecorders.map((r) => r.mixerInput)).toEqual(['video_in_1']);
    expect(result.warnings).toEqual([
      { type: 'input-recording-incomplete', message: expect.stringContaining('video_in_2 is not recorded: passthrough') },
    ]);
  });

  it('records picture only, with a warning, when Strom has no builtin.audioenc', async () => {
    const { result, flow } = await activate(BOTH, { blocks: ['builtin.liverecorder', 'builtin.videoenc'] });
    expect(result.inputRecorders.map((r) => Object.keys(r.blockIds))).toEqual([['video'], ['video']]);
    expect(flow.blocks.some((b) => String(b['id']).startsWith('b-inrec-aenc'))).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-incomplete', message: expect.stringContaining('without sound') }),
    ]);
  });

  it('records sound only, with a warning, when Strom has no builtin.videoenc', async () => {
    const { result, flow } = await activate(BOTH, { blocks: ['builtin.liverecorder', 'builtin.audioenc'] });
    expect(result.inputRecorders.map((r) => Object.keys(r.blockIds))).toEqual([['audio'], ['audio']]);
    expect(flow.blocks.some((b) => String(b['id']).startsWith('b-inrec-venc'))).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-incomplete', message: expect.stringContaining('without picture') }),
    ]);
  });

  it('adds no input recorder, with a warning, when Strom has no builtin.liverecorder', async () => {
    const { result } = await activate(BOTH, { blocks: ['builtin.videoenc', 'builtin.audioenc'] });
    expect(result.inputRecorders).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-incomplete', message: expect.stringContaining('not recorded') }),
    ]);
  });

  it('lists Strom blocks once per activation', async () => {
    const { strom } = await activate(BOTH, { outputs: [recordingOutput] });
    expect(strom.blocks.list).toHaveBeenCalledOnce();
  });
});

describe('POST /api/v1/productions/:id/sources — record', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({
      _id: 'prod-iso-1', _rev: '1-a', type: 'production', name: 'ISO', status: 'inactive', sources: [],
      pipeline: { stromConfig: null, status: 'stopped' }, graphics: [], macros: [], tally: { pgm: null, pvw: null },
      createdAt: '', updatedAt: '',
    });
    mockInsert.mockResolvedValue({ ok: true, rev: '2-b' });
  });

  async function assign(extra: Record<string, unknown>) {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    return app.inject({
      method: 'POST', url: '/api/v1/productions/prod-iso-1/sources',
      payload: { sourceId: 'Whip', mixerInput: 'video_in_1', ...extra },
    });
  }

  const saved = () => mockInsert.mock.calls[0]![0].sources[0];

  it('saves record: transcode on the assignment', async () => {
    const res = await assign({ record: 'transcode' });
    expect(res.statusCode).toBe(201);
    expect(saved()).toEqual({ sourceId: 'Whip', mixerInput: 'video_in_1', record: 'transcode' });
  });

  it.each([{}, { record: 'off' }])('leaves recording off for %j', async (extra) => {
    const res = await assign(extra);
    expect(res.statusCode).toBe(201);
    expect(saved()).not.toHaveProperty('record');
  });

  it.each(['passthrough', 'on', true])('rejects record: %j', async (record) => {
    const res = await assign({ record });
    expect(res.statusCode).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
