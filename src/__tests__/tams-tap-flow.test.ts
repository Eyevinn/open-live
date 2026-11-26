/**
 * TAMS tap — flow shape (src/lib/tams-tap.ts):
 *  - off unless TAMS_GATEWAY_URL is set: no tap blocks, no warning, no change;
 *  - on: one builtin.tams_output per input, inside the production's single flow,
 *    tapped from the input's feed, video (stamped with absolute time) and audio
 *    both encoded (TAMS Output refuses raw input), each behind a leaky queue;
 *    tagged for Open Replay; no credential in the flow;
 *  - a Strom without the blocks, or an unreadable block list, skips the tap
 *    with a warning instead of making Strom refuse the flow;
 *  - TAMS_MAX_INPUTS caps the taps and says which inputs were skipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SOURCES: Record<string, Record<string, unknown>> = {
  'src-srt': { _id: 'src-srt', type: 'source', name: 'Camera 1', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller', latency: 125 },
  'src-replay': { _id: 'src-replay', type: 'source', name: 'Open Replay PGM', streamType: 'srt', address: 'srt://:5030?mode=listener', recordToTams: false },
  'src-efp': { _id: 'src-efp', type: 'source', name: 'EFP Cam', streamType: 'efp', address: 'srt://10.0.0.2:9000?mode=caller' },
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

const ALL_BLOCKS = [
  'builtin.recorder', 'builtin.audioenc', 'builtin.liverecorder', 'builtin.videoenc', 'builtin.tams_output',
  'builtin.reference_timestamp',
];

function makeStromClient(
  blockIds: string[] | 'unreadable' = ALL_BLOCKS,
  over: { setPat?: ReturnType<typeof vi.fn>; start?: ReturnType<typeof vi.fn> } = {},
) {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    osc: {
      setPat: over.setPat ?? vi.fn().mockResolvedValue({}),
      clearPat: vi.fn().mockResolvedValue({}),
    },
    blocks: {
      list: blockIds === 'unreadable'
        ? vi.fn().mockRejectedValue(new Error('strom down'))
        : vi.fn().mockResolvedValue({ blocks: blockIds.map((id) => ({ id })) }),
    },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-tams-1' } });
      }),
      start: over.start ?? vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

type Assignment = { sourceId: string; mixerInput: string };

function production(sources: Assignment[]) {
  return {
    _id: 'prod-tams-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Cup Final',
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

type Flow = {
  blocks: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
};

async function activate(
  sources: Assignment[],
  opts: { blocks?: string[] | 'unreadable'; setPat?: ReturnType<typeof vi.fn>; start?: ReturnType<typeof vi.fn> } = {},
) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient(opts.blocks, { setPat: opts.setPat, start: opts.start });
  const result = await activateStromFlow(production(sources) as never, strom as never, 'http://localhost:7000', [] as never);
  return { result, flow: strom.capturedFlows[0] as unknown as Flow, strom };
}

const tamsBlocks = (flow: Flow) => flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.tams_output');
const props = (b: Record<string, unknown>) => b['properties'] as Record<string, unknown>;
const linkTo = (flow: Flow, to: string) => flow.links.find((l) => l['to'] === to);

const ENV = [
  'TAMS_GATEWAY_URL', 'TAMS_AUTH_MODE', 'TAMS_CONTAINER', 'TAMS_SEGMENT_SECS', 'TAMS_SEGMENT_MS',
  'TAMS_KEYFRAME_INTERVAL', 'TAMS_VIDEO_BITRATE_KBPS', 'TAMS_VIDEO_PRESET', 'TAMS_VIDEO_TUNE', 'TAMS_MAX_INPUTS',
  'OSC_ACCESS_TOKEN', 'OSC_PAT',
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const n of ENV) delete process.env[n];
});
afterEach(() => {
  for (const n of ENV) delete process.env[n];
});

const TWO: Assignment[] = [
  { sourceId: 'src-srt', mixerInput: 'video_in_1' },
  { sourceId: 'src-efp', mixerInput: 'video_in_2' },
];

describe('off by default', () => {
  it('builds no tap, raises no warning and does not read the block list for it', async () => {
    const { result, flow } = await activate(TWO);
    expect(tamsBlocks(flow)).toEqual([]);
    expect(flow.elements.filter((e) => String(e['id']).startsWith('e-tams-'))).toEqual([]);
    expect(result.tamsTaps).toEqual([]);
    expect(result.warnings.filter((w) => w.type.startsWith('tams-'))).toEqual([]);
  });
});

describe('on: one tap per input inside the single flow', () => {
  beforeEach(() => {
    process.env['TAMS_GATEWAY_URL'] = 'https://tams.example.com/';
  });

  it('adds one tams_output per input, keyed by the stored pad index, to the one flow', async () => {
    const { result, flow, strom } = await activate(TWO);
    expect(strom.flows.create).toHaveBeenCalledTimes(1);
    expect(tamsBlocks(flow).map((b) => b['id'])).toEqual([
      expect.stringMatching(/^b-tams-1-/),
      expect.stringMatching(/^b-tams-2-/),
    ]);
    expect(result.tamsTaps.map((t) => [t.mixerInput, t.sourceName])).toEqual([
      ['video_in_1', 'Camera 1'],
      ['video_in_2', 'EFP Cam'],
    ]);
    expect(result.warnings.filter((w) => w.type.startsWith('tams-'))).toEqual([]);
  });

  it('leaves out a source marked recordToTams: false, so a replay fed back in is not recorded', async () => {
    const { result, flow } = await activate([
      ...TWO,
      { sourceId: 'src-replay', mixerInput: 'video_in_3' },
    ]);
    expect(tamsBlocks(flow)).toHaveLength(2);
    expect(result.tamsTaps.map((t) => t.sourceName)).toEqual(['Camera 1', 'EFP Cam']);
    expect(result.warnings.filter((w) => w.type.startsWith('tams-'))).toEqual([]);
  });

  it('configures the block without a credential and with a stable source id', async () => {
    const first = await activate(TWO);
    const p = props(tamsBlocks(first.flow)[0]!);
    expect(p).toMatchObject({
      gateway_url: 'https://tams.example.com',
      auth_mode: 'static',
      container: 'mpegts',
      segment_duration_secs: 1,
      num_video_tracks: 1,
      num_audio_tracks: 1,
      label: 'Camera 1',
      tags: 'production=prod-tams-1, replay_group=Cup Final, angle=video_in_1, source_name=Camera 1, open_live_source=src-srt',
    });
    expect(p).not.toHaveProperty('api_token');
    expect(JSON.stringify(first.flow)).not.toMatch(/token/i);
    expect(p['tams_source_id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    vi.resetModules();
    const second = await activate(TWO);
    expect(props(tamsBlocks(second.flow)[0]!)['tams_source_id']).toBe(p['tams_source_id']);
    expect(props(tamsBlocks(second.flow)[1]!)['tams_source_id']).not.toBe(p['tams_source_id']);
  });

  it('encodes the video and the audio, each behind a leaky queue, from the input feed', async () => {
    const { flow } = await activate([TWO[0]!]);
    const tams = String(tamsBlocks(flow)[0]!['id']);
    const venc = flow.blocks.find((b) => String(b['id']).startsWith('b-tams-venc-1-'))!;
    expect(venc['block_definition_id']).toBe('builtin.videoenc');
    // No limit on keyframe requests, so TAMS Output can ask for one at every grid point.
    expect(props(venc)).toMatchObject({
      codec: 'h264', bitrate: 4000, keyframe_interval: 15, min_keyframe_request_interval_ms: 0, tune: 'zerolatency',
      quality_preset: 'ultrafast',
    });
    const stamp = flow.blocks.find((b) => String(b['id']).startsWith('b-tams-ts-1-'))!;
    expect(stamp['block_definition_id']).toBe('builtin.reference_timestamp');
    expect(props(stamp)).toMatchObject({ timescale: 'tai', burn_in: false });

    const vq = flow.elements.find((e) => String(e['id']).startsWith('e-tams-vq-1-'))!;
    const aq = flow.elements.find((e) => String(e['id']).startsWith('e-tams-aq-1-'))!;
    for (const q of [vq, aq]) {
      expect(props(q)).toMatchObject({ leaky: 'downstream', 'max-size-buffers': 0, 'max-size-bytes': 0 });
    }
    // Video: input feed -> queue -> encoder -> tams video_in_0. Audio: feed -> queue -> tams audio_in_0.
    expect(linkTo(flow, `${vq['id']}:sink`)!['from']).toMatch(/^b-input-1-.*:video_out$/);
    expect(linkTo(flow, `${stamp['id']}:in`)!['from']).toBe(`${vq['id']}:src`);
    expect(linkTo(flow, `${venc['id']}:video_in`)!['from']).toBe(`${stamp['id']}:out`);
    expect(linkTo(flow, `${tams}:video_in_0`)!['from']).toBe(`${venc['id']}:encoded_out`);
    expect(linkTo(flow, `${aq["id"]}:sink`)!["from"]).toMatch(/^b-input-1-.*:audio_out_0$/);
    const aenc = flow.blocks.find((b) => String(b['id']).startsWith('b-tams-aenc-1-'))!;
    expect(aenc['block_definition_id']).toBe('builtin.audioenc');
    expect(props(aenc)).toMatchObject({ codec: 'aac' });
    expect(linkTo(flow, `${aenc['id']}:audio_in`)!['from']).toBe(`${aq['id']}:src`);
    // Never raw into TAMS Output: its audio comes from the encoder, not the queue.
    expect(linkTo(flow, `${tams}:audio_in_0`)!['from']).toBe(`${aenc['id']}:encoded_out`);
  });

  it('leaves the timestamp block out, and still taps, on a Strom without it', async () => {
    const blocks = ALL_BLOCKS.filter((b) => b !== 'builtin.reference_timestamp');
    const { result, flow } = await activate([TWO[0]!], { blocks });
    expect(flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.reference_timestamp')).toEqual([]);
    const vq = flow.elements.find((e) => String(e['id']).startsWith('e-tams-vq-1-'))!;
    const venc = flow.blocks.find((b) => String(b['id']).startsWith('b-tams-venc-1-'))!;
    expect(linkTo(flow, `${venc['id']}:video_in`)!['from']).toBe(`${vq['id']}:src`);
    expect(result.tamsTaps).toHaveLength(1);
    expect(result.warnings.filter((w) => w.type.startsWith('tams-'))).toEqual([]);
  });

  it('keeps commas and line breaks of a source name out of the tags', async () => {
    SOURCES['src-srt'] = { ...SOURCES['src-srt']!, name: 'Cam 1, north\nend' };
    const { flow } = await activate([TWO[0]!]);
    const tags = String(props(tamsBlocks(flow)[0]!)['tags']);
    expect(tags).toContain('source_name=Cam 1 north end');
    expect(tags.split(', ')).toHaveLength(5);
    SOURCES['src-srt'] = { ...SOURCES['src-srt']!, name: 'Camera 1' };
  });

  it('passes no millisecond segment length unless asked, so an older Strom is not sent a property it lacks', async () => {
    const { flow } = await activate([TWO[0]!]);
    expect(props(tamsBlocks(flow)[0]!)).not.toHaveProperty('segment_duration_ms');
  });

  it('passes TAMS_SEGMENT_MS to the block for sub-second segments', async () => {
    process.env['TAMS_SEGMENT_MS'] = '500';
    const { flow } = await activate([TWO[0]!]);
    expect(props(tamsBlocks(flow)[0]!)).toMatchObject({ segment_duration_ms: 500, segment_duration_secs: 1 });
  });

  it('follows the TAMS_* settings', async () => {
    process.env['TAMS_AUTH_MODE'] = 'osc';
    process.env['OSC_ACCESS_TOKEN'] = 'pat-test-value-123';
    process.env['TAMS_CONTAINER'] = 'mp4';
    process.env['TAMS_SEGMENT_SECS'] = '2';
    process.env['TAMS_KEYFRAME_INTERVAL'] = '30';
    process.env['TAMS_VIDEO_BITRATE_KBPS'] = '8000';
    process.env['TAMS_VIDEO_PRESET'] = 'medium';
    process.env['TAMS_VIDEO_TUNE'] = 'film';
    const { flow } = await activate([TWO[0]!]);
    expect(props(tamsBlocks(flow)[0]!)).toMatchObject({ auth_mode: 'osc', container: 'mp4', segment_duration_secs: 2 });
    const venc = flow.blocks.find((b) => String(b['id']).startsWith('b-tams-venc-'))!;
    expect(props(venc)).toMatchObject({ bitrate: 8000, keyframe_interval: 30, quality_preset: 'medium', tune: 'film' });
  });
});

describe('Strom without the blocks', () => {
  beforeEach(() => {
    process.env['TAMS_GATEWAY_URL'] = 'https://tams.example.com';
  });

  it('skips the tap with tams-unavailable when builtin.tams_output is missing', async () => {
    const { result, flow } = await activate(TWO, { blocks: ['builtin.recorder', 'builtin.audioenc', 'builtin.videoenc'] });
    expect(tamsBlocks(flow)).toEqual([]);
    expect(result.tamsTaps).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      type: 'tams-unavailable', mixerInputs: ['video_in_1', 'video_in_2'],
    }));
  });

  it('skips the tap with tams-unavailable when builtin.audioenc is missing', async () => {
    const { result, flow } = await activate(TWO, { blocks: ['builtin.tams_output', 'builtin.videoenc'] });
    expect(tamsBlocks(flow)).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'tams-unavailable' }));
  });

  it('skips the tap, rather than guess, when the block list cannot be read', async () => {
    const { result, flow } = await activate(TWO, { blocks: 'unreadable' });
    expect(tamsBlocks(flow)).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'tams-unavailable' }));
  });
});

describe('TAMS_MAX_INPUTS', () => {
  beforeEach(() => {
    process.env['TAMS_GATEWAY_URL'] = 'https://tams.example.com';
  });

  it('taps the first N by stored pad index and names the rest', async () => {
    process.env['TAMS_MAX_INPUTS'] = '1';
    const { result, flow } = await activate([
      { sourceId: 'src-efp', mixerInput: 'video_in_2' },
      { sourceId: 'src-srt', mixerInput: 'video_in_1' },
    ]);
    expect(tamsBlocks(flow)).toHaveLength(1);
    expect(result.tamsTaps.map((t) => t.mixerInput)).toEqual(['video_in_1']);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'tams-capped', mixerInputs: ['video_in_2'] }));
  });

  it('0 turns the tap off for the production, with a warning naming every input', async () => {
    process.env['TAMS_MAX_INPUTS'] = '0';
    const { result, flow } = await activate(TWO);
    expect(tamsBlocks(flow)).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'tams-capped', mixerInputs: ['video_in_1', 'video_in_2'] }));
  });
});

describe('OSC token for the TAMS blocks (auth_mode osc)', () => {
  const PAT = 'pat-test-value-123';
  beforeEach(() => {
    process.env['TAMS_GATEWAY_URL'] = 'https://tams.example.com';
    process.env['TAMS_AUTH_MODE'] = 'osc';
  });

  it("hands Open Live's token to Strom for the new flow, after create and before start", async () => {
    process.env['OSC_ACCESS_TOKEN'] = PAT;
    const { flow, strom } = await activate(TWO);
    expect(strom.osc.setPat).toHaveBeenCalledTimes(1);
    expect(strom.osc.setPat).toHaveBeenCalledWith('flow-tams-1', PAT);
    const order = (f: ReturnType<typeof vi.fn>) => f.mock.invocationCallOrder[0]!;
    expect(order(strom.flows.create)).toBeLessThan(order(strom.osc.setPat));
    expect(order(strom.osc.setPat)).toBeLessThan(order(strom.flows.start));
    // The token goes to Strom's PAT endpoint only, never into the flow definition.
    expect(JSON.stringify(flow)).not.toContain(PAT);
  });

  it('pushes nothing in static mode', async () => {
    process.env['TAMS_AUTH_MODE'] = 'static';
    process.env['OSC_ACCESS_TOKEN'] = PAT;
    const { strom } = await activate(TWO);
    expect(strom.osc.setPat).not.toHaveBeenCalled();
  });

  it('pushes nothing when no input is written to TAMS', async () => {
    process.env['OSC_ACCESS_TOKEN'] = PAT;
    const { strom } = await activate(TWO, { blocks: ['builtin.recorder'] });
    expect(strom.osc.setPat).not.toHaveBeenCalled();
  });

  it('leaves the tap out, with a warning, when Open Live has no token to hand over', async () => {
    const { result, flow, strom } = await activate(TWO);
    expect(tamsBlocks(flow)).toEqual([]);
    expect(result.tamsTaps).toEqual([]);
    expect(strom.osc.setPat).not.toHaveBeenCalled();
    expect(result.warnings).toContainEqual(expect.objectContaining({
      type: 'tams-no-token', mixerInputs: ['video_in_1', 'video_in_2'],
    }));
  });

  it('still starts the production, and warns without the token, when Strom refuses it', async () => {
    process.env['OSC_ACCESS_TOKEN'] = PAT;
    const setPat = vi.fn().mockRejectedValue(new Error('404 Not Found'));
    const { result, strom } = await activate(TWO, { setPat });
    expect(strom.flows.start).toHaveBeenCalledTimes(1);
    expect(result.tamsTaps).toHaveLength(2);
    const w = result.warnings.find((x) => x.type === 'tams-no-token')!;
    expect(w.message).toContain('404 Not Found');
    expect(JSON.stringify(result.warnings)).not.toContain(PAT);
  });

  it('forgets the token again when the flow fails to start', async () => {
    process.env['OSC_ACCESS_TOKEN'] = PAT;
    const start = vi.fn().mockRejectedValue(new Error('boom'));
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient(ALL_BLOCKS, { start });
    await expect(
      activateStromFlow(production(TWO) as never, strom as never, 'http://localhost:7000', [] as never),
    ).rejects.toThrow('boom');
    expect(strom.osc.clearPat).toHaveBeenCalledWith('flow-tams-1');
    expect(strom.flows.delete).toHaveBeenCalledWith('flow-tams-1');
  });

  it('forgets the token on deactivate, in osc mode only', async () => {
    const { deactivateStromFlow } = await import('../lib/flow-generator.js');
    const osc = makeStromClient();
    await deactivateStromFlow('flow-9', osc as never);
    expect(osc.osc.clearPat).toHaveBeenCalledWith('flow-9');

    vi.resetModules();
    process.env['TAMS_AUTH_MODE'] = 'static';
    const { deactivateStromFlow: again } = await import('../lib/flow-generator.js');
    const st = makeStromClient();
    await again('flow-9', st as never);
    expect(st.osc.clearPat).not.toHaveBeenCalled();
  });
});

describe('TAMS_SEGMENT_MS validation', () => {
  it.each(['50', '199', '10001', '-1', 'abc'])('rejects %s', async (v) => {
    process.env['TAMS_SEGMENT_MS'] = v;
    await expect(import('../config.js')).rejects.toThrow(/TAMS_SEGMENT_MS/);
  });

  it.each(['0', '200', '500', '10000'])('accepts %s', async (v) => {
    process.env['TAMS_SEGMENT_MS'] = v;
    await expect(import('../config.js')).resolves.toBeDefined();
  });
});

describe('TAMS_GATEWAY_URL validation', () => {
  it('rejects a URL that carries credentials', async () => {
    process.env['TAMS_GATEWAY_URL'] = 'https://user:secret@tams.example.com';
    await expect(import('../config.js')).rejects.toThrow(/without credentials/);
  });

  it('rejects a non-http URL', async () => {
    process.env['TAMS_GATEWAY_URL'] = 'ftp://tams.example.com';
    await expect(import('../config.js')).rejects.toThrow(/http\(s\) URL/);
  });
});
