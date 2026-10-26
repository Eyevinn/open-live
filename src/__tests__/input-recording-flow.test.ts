/**
 * OL-32 ISO input recording — flow shape (spec iso-input-recording.md §4.3,
 * §2.7; ADR-011):
 *  - `record` off (absent) builds no input recorder and raises no warning;
 *  - one builtin.liverecorder per recorded input, tapped before the input's
 *    time_offset blocks, video through a leaky queue + H.264 encode, raw audio
 *    through a leaky queue;
 *  - the four activation warnings: unavailable (builtin.recorder path), no
 *    output, capped, unsupported source.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SOURCES: Record<string, Record<string, unknown>> = {
  'src-srt': { _id: 'src-srt', type: 'source', name: 'Camera 1', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller', latency: 125 },
  'src-efp': { _id: 'src-efp', type: 'source', name: 'EFP Cam', streamType: 'efp', address: 'srt://10.0.0.2:9000?mode=caller' },
  'src-html': { _id: 'src-html', type: 'source', name: 'Lower third', streamType: 'html', address: 'https://example.com/g.html' },
};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = SOURCES[id];
      if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { ...doc };
    }),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const ALL_BLOCKS = ['builtin.recorder', 'builtin.audioenc', 'builtin.liverecorder'];

function makeStromClient(blockIds: string[] = ALL_BLOCKS) {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: { list: vi.fn().mockResolvedValue({ blocks: blockIds.map((id) => ({ id })) }) },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-iso-1' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

type Assignment = { sourceId: string; mixerInput: string; record?: 'transcode'; returnFeed?: { synced: 'program-minus' } };

function production(sources: Assignment[]) {
  return {
    _id: 'prod-iso-1',
    _rev: '1-abc',
    type: 'production',
    name: 'ISO Production',
    status: 'inactive',
    sources,
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

const recordingOutput = {
  _id: 'output-rec-iso12345',
  type: 'output' as const,
  outputType: 'recording' as const,
  name: 'VOD Recording',
  createdAt: '',
  updatedAt: '',
};

type Flow = {
  blocks: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
};

async function activate(
  sources: Assignment[],
  opts: { blocks?: string[]; outputs?: unknown[] } = {},
) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient(opts.blocks);
  const result = await activateStromFlow(
    production(sources) as never,
    strom as never,
    'http://localhost:7000',
    (opts.outputs ?? [recordingOutput]) as never,
  );
  return { result, flow: strom.capturedFlows[0] as unknown as Flow };
}

const liveRecorders = (flow: Flow) => flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.liverecorder');
const inputRecorders = (flow: Flow) => liveRecorders(flow).filter((b) => String(b['id']).startsWith('b-inrec-'));
const linkTo = (flow: Flow, to: string) => flow.links.find((l) => l['to'] === to);
const linksFrom = (flow: Flow, from: string) => flow.links.filter((l) => l['from'] === from).map((l) => String(l['to']));

const ENV = ['RECORDING_BLOCK', 'RECORDING_SEGMENT_SECS', 'RECORDING_MAX_INPUTS', 'RECORDING_INPUT_VIDEO_BITRATE_KBPS'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const n of ENV) delete process.env[n];
});
afterEach(() => {
  for (const n of ENV) delete process.env[n];
});

describe('input recording off by default (AC 4)', () => {
  it('builds no input recorder and raises no warning when no assignment records', async () => {
    const { result, flow } = await activate([
      { sourceId: 'src-srt', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_1' },
    ]);
    expect(inputRecorders(flow)).toEqual([]);
    expect(flow.elements.filter((e) => String(e['id']).startsWith('e-inrec-'))).toEqual([]);
    expect(liveRecorders(flow)).toHaveLength(1); // program only
    expect(result.inputRecorders).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('raises no warning on a Strom without Live Recorder when no input records', async () => {
    const { result } = await activate([{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], {
      blocks: ['builtin.recorder', 'builtin.audioenc'],
    });
    expect(result.warnings).toEqual([]);
  });
});

describe('one Live Recorder per recorded input (spec §4.3)', () => {
  const sources: Assignment[] = [
    { sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' },
    { sourceId: 'src-efp', mixerInput: 'video_in_2' },
    { sourceId: 'Whip', mixerInput: 'video_in_15', record: 'transcode', returnFeed: { synced: 'program-minus' } },
  ];

  it('builds exactly one recorder per recorded input, keyed by the stored pad index', async () => {
    const { result, flow } = await activate(sources);
    expect(inputRecorders(flow).map((b) => b['id'])).toEqual([
      expect.stringMatching(/^b-inrec-1-/),
      expect.stringMatching(/^b-inrec-15-/),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.inputRecorders).toEqual([
      {
        mixerInput: 'video_in_1', sourceId: 'src-srt', sourceName: 'Camera 1', streamType: 'srt',
        recorderBlockId: expect.stringMatching(/^b-inrec-1-/), outputDir: 'recordings/prod-iso-1/video_in_1',
      },
      {
        // A WHIP guest slot carries the multiviewer's guest label (spec §3.1).
        mixerInput: 'video_in_15', sourceId: 'Whip', sourceName: 'Guest 1 · In 16', streamType: 'whip',
        recorderBlockId: expect.stringMatching(/^b-inrec-15-/), outputDir: 'recordings/prod-iso-1/video_in_15',
      },
    ]);
  });

  it('sets the recorder and encoder properties from the spec and the env', async () => {
    process.env['RECORDING_SEGMENT_SECS'] = '300';
    process.env['RECORDING_INPUT_VIDEO_BITRATE_KBPS'] = '2500';
    const { flow } = await activate(sources);
    const rec = flow.blocks.find((b) => String(b['id']).startsWith('b-inrec-1-'))!;
    expect(rec['name']).toBe('Record video_in_1');
    expect(rec['properties']).toEqual({
      output_dir: 'recordings/prod-iso-1/video_in_1',
      filename_prefix: 'prod-iso-1_video_in_1',
      max_size_time_secs: 300,
      num_video_tracks: 1,
      num_audio_tracks: 1,
    });
    const venc = flow.blocks.find((b) => String(b['id']).startsWith('b-inrec-venc-1-'))!;
    expect(venc['block_definition_id']).toBe('builtin.videoenc');
    expect(venc['properties']).toEqual({ codec: 'h264', bitrate: 2500, keyframe_interval: 60 });
    for (const q of flow.elements.filter((e) => /^e-inrec-[va]q-/.test(String(e['id'])))) {
      expect(q['element_type']).toBe('queue');
      expect(q['properties']).toMatchObject({ leaky: 'downstream', 'max-size-time': 1_000_000_000 });
    }
  });

  it('omits max_size_time_secs with RECORDING_SEGMENT_SECS=0', async () => {
    process.env['RECORDING_SEGMENT_SECS'] = '0';
    const { flow } = await activate(sources);
    expect(inputRecorders(flow)[0]!['properties']).not.toHaveProperty('max_size_time_secs');
  });

  it('taps an SRT input before its time_offset blocks (AC 2)', async () => {
    const { flow } = await activate(sources);
    const input = flow.blocks.find((b) => String(b['id']).startsWith('b-input-1-'))!;
    const inputId = input['id'] as string;
    const recId = inputRecorders(flow).find((b) => String(b['id']).startsWith('b-inrec-1-'))!['id'] as string;
    const vencId = flow.blocks.find((b) => String(b['id']).startsWith('b-inrec-venc-1-'))!['id'] as string;
    const vq = flow.elements.find((e) => String(e['id']).startsWith('e-inrec-vq-1-'))!['id'] as string;
    const aq = flow.elements.find((e) => String(e['id']).startsWith('e-inrec-aq-1-'))!['id'] as string;

    // The same pad feeds the offset block and the recording branch.
    expect(linksFrom(flow, `${inputId}:video_out`)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^b-offset-1-.*:in$/), `${vq}:sink`,
    ]));
    expect(linksFrom(flow, `${inputId}:audio_out_0`)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^b-audio-offset-1-.*:in$/), `${aq}:sink`,
    ]));
    const vmem = flow.elements.find((e) => String(e['id']).startsWith('e-inrec-vmem-1-'))!['id'] as string;
    expect(linkTo(flow, `${vmem}:sink`)?.['from']).toBe(`${vq}:src`);
    expect(linkTo(flow, `${vencId}:video_in`)?.['from']).toBe(`${vmem}:src`);
    expect(linkTo(flow, `${recId}:video_in_0`)?.['from']).toBe(`${vencId}:encoded_out`);
    expect(linkTo(flow, `${recId}:audio_in_0`)?.['from']).toBe(`${aq}:src`);
  });

  it('pins system memory in front of the input video encoder (#569: CUDA memory never encodes)', async () => {
    const { flow } = await activate(sources);
    for (const n of [1, 15]) {
      const vmem = flow.elements.find((e) => String(e['id']).startsWith(`e-inrec-vmem-${n}-`))!;
      expect(vmem['element_type']).toBe('capsfilter');
      // No caps features: system memory, never memory:CUDAMemory / GLMemory.
      expect(vmem['properties']).toEqual({ caps: 'video/x-raw' });
      const vencId = flow.blocks.find((b) => String(b['id']).startsWith(`b-inrec-venc-${n}-`))!['id'] as string;
      expect(linkTo(flow, `${vencId}:video_in`)?.['from']).toBe(`${vmem['id'] as string}:src`);
    }
  });

  it('taps a WHIP input at video_out / audio_out', async () => {
    const { flow } = await activate(sources);
    const inputId = flow.blocks.find((b) => String(b['id']).startsWith('b-input-15-'))!['id'] as string;
    const vq = flow.elements.find((e) => String(e['id']).startsWith('e-inrec-vq-15-'))!['id'] as string;
    const aq = flow.elements.find((e) => String(e['id']).startsWith('e-inrec-aq-15-'))!['id'] as string;
    expect(linksFrom(flow, `${inputId}:video_out`)).toContain(`${vq}:sink`);
    expect(linksFrom(flow, `${inputId}:audio_out`)).toContain(`${aq}:sink`);
  });

  it('leaves the recorded input wired to the mixer exactly as before', async () => {
    const withRecord = await activate(sources);
    vi.resetModules();
    const without = await activate(sources.map(({ record: _r, ...a }) => a));
    const notRecording = (f: Flow) => f.links
      .filter((l) => !/inrec/.test(String(l['from'])) && !/inrec/.test(String(l['to'])))
      .map((l) => `${String(l['from']).replace(/^[0-9a-f]{32}/, 'X')}>${String(l['to']).replace(/^[0-9a-f]{32}/, 'X')}`)
      .sort();
    expect(notRecording(withRecord.flow)).toEqual(notRecording(without.flow));
  });
});

describe('input recording warnings (spec §2.7)', () => {
  it('input-recording-unavailable on the builtin.recorder path; program still records', async () => {
    const { result, flow } = await activate(
      [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
      { blocks: ['builtin.recorder', 'builtin.audioenc'] },
    );
    expect(inputRecorders(flow)).toEqual([]);
    expect(flow.blocks.find((b) => b['block_definition_id'] === 'builtin.recorder')).toBeDefined();
    expect(result.recorderType).toBe('recorder');
    expect(result.inputRecorders).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-unavailable', mixerInputs: ['video_in_1'] }),
    ]);
  });

  it('input-recording-unavailable with RECORDING_BLOCK=recorder', async () => {
    process.env['RECORDING_BLOCK'] = 'recorder';
    const { result } = await activate([{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }]);
    expect(result.warnings.map((w) => w.type)).toEqual(['input-recording-unavailable']);
  });

  it('input-recording-no-output without a recording output (AC 5)', async () => {
    const { result, flow } = await activate(
      [{ sourceId: 'src-srt', mixerInput: 'video_in_1', record: 'transcode' }],
      { outputs: [] },
    );
    expect(liveRecorders(flow)).toEqual([]);
    expect(result.inputRecorders).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-no-output', mixerInputs: ['video_in_1'] }),
    ]);
  });

  it('input-recording-capped records the first N by numeric pad index', async () => {
    process.env['RECORDING_MAX_INPUTS'] = '2';
    const { result, flow } = await activate([
      { sourceId: 'src-srt', mixerInput: 'video_in_10', record: 'transcode' },
      { sourceId: 'src-efp', mixerInput: 'video_in_2', record: 'transcode' },
      { sourceId: 'Whip', mixerInput: 'video_in_9', record: 'transcode' },
    ]);
    expect(result.inputRecorders.map((r) => r.mixerInput)).toEqual(['video_in_2', 'video_in_9']);
    expect(inputRecorders(flow)).toHaveLength(2);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-capped', mixerInputs: ['video_in_10'] }),
    ]);
  });

  it('input-recording-unsupported-source for a source that cannot be recorded', async () => {
    const { result, flow } = await activate([
      { sourceId: 'src-html', mixerInput: 'video_in_0', record: 'transcode' },
      { sourceId: '__test1__', mixerInput: 'video_in_1', record: 'transcode' },
      { sourceId: 'src-srt', mixerInput: 'video_in_2', record: 'transcode' },
    ]);
    expect(result.inputRecorders.map((r) => r.mixerInput)).toEqual(['video_in_2']);
    expect(inputRecorders(flow)).toHaveLength(1);
    expect(result.warnings).toEqual([
      expect.objectContaining({ type: 'input-recording-unsupported-source', mixerInput: 'video_in_0', sourceId: 'src-html' }),
      expect.objectContaining({ type: 'input-recording-unsupported-source', mixerInput: 'video_in_1', sourceId: '__test1__' }),
    ]);
  });
});

describe('planInputRecordings', () => {
  it('records nothing with a cap of 0', async () => {
    const { planInputRecordings } = await import('../lib/input-recording.js');
    const plan = planInputRecordings(
      [{ sourceId: 's', mixerInput: 'video_in_0', record: 'transcode' }],
      () => ({ streamType: 'srt', name: 'S' }),
      { recorderType: 'liverecorder', maxInputs: 0 },
    );
    expect(plan.record).toEqual([]);
    expect(plan.warnings.map((w) => w.type)).toEqual(['input-recording-capped']);
  });
});

describe('RECORDING_MAX_INPUTS / RECORDING_INPUT_VIDEO_BITRATE_KBPS parsing (spec §10.1)', () => {
  it('defaults to 4 and 4000', async () => {
    const { config } = await import('../config.js');
    expect(config.recordingMaxInputs).toBe(4);
    expect(config.recordingInputVideoBitrateKbps).toBe(4000);
  });

  it.each([
    ['RECORDING_MAX_INPUTS', '17'],
    ['RECORDING_MAX_INPUTS', '-1'],
    ['RECORDING_MAX_INPUTS', 'four'],
    ['RECORDING_INPUT_VIDEO_BITRATE_KBPS', '499'],
    ['RECORDING_INPUT_VIDEO_BITRATE_KBPS', '50001'],
  ])('fails startup on %s=%s', async (name, value) => {
    process.env[name] = value;
    await expect(import('../config.js')).rejects.toThrow(name);
  });

  it('accepts 0 for RECORDING_MAX_INPUTS', async () => {
    process.env['RECORDING_MAX_INPUTS'] = '0';
    const { config } = await import('../config.js');
    expect(config.recordingMaxInputs).toBe(0);
  });
});

describe('RECORDING_STATE (spec §2.8)', () => {
  it('reports program and the recorded inputs by stored mixerInput, without internal fields', async () => {
    const { recordingStateMessage } = await import('../lib/input-recording.js');
    expect(recordingStateMessage({
      recorderBlockId: 'b-out-1',
      inputRecordings: [{
        mixerInput: 'video_in_15', sourceId: 'Whip', sourceName: 'Guest 1 · In 16', streamType: 'whip',
        recorderBlockId: 'b-inrec-15-x', outputDir: 'recordings/p/video_in_15',
      }],
    })).toEqual({
      type: 'RECORDING_STATE',
      program: true,
      inputs: [{ mixerInput: 'video_in_15', sourceId: 'Whip', sourceName: 'Guest 1 · In 16' }],
    });
    expect(recordingStateMessage(undefined)).toEqual({ type: 'RECORDING_STATE', program: false, inputs: [] });
  });
});
