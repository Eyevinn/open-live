/**
 * Audio-stream selection at activation (issue #516, spec
 * docs/specs/audio-stream-selection.md §5.3/§5.4, ADR-010).
 *
 * On a Strom whose `builtin.mpegtssrt_input` exposes `map_audio_by_pid`
 * (strom#1081, v0.8.0-alpha.1) an srt source with 0 < k <= 7 gets
 * `num_audio_tracks: k + 1`, `audio_out_<k>` selected and every other output
 * drained once (issue #545). Every other `audioStreamIndex > 0` is clamped to
 * the first stream: the SRT/EFP input block and its links stay byte-identical
 * to the k = 0 shape, and one `audio-stream-not-applied` warning is raised per
 * affected mixer input. Strom + CouchDB mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sources = new Map<string, Record<string, unknown>>();

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation((id: string) => {
      const doc = sources.get(id);
      // Return a copy: activateStromFlow mutates `address` while decrypting.
      return doc ? Promise.resolve({ ...doc }) : Promise.reject(new Error('not found'));
    }),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

function makeSource(id: string, streamType: 'srt' | 'efp', audioStreamIndex?: number) {
  return {
    _id: id,
    type: 'source',
    name: `Cam ${id}`,
    address: 'srt://192.0.2.10:9000?mode=caller',
    streamType,
    status: 'active',
    latency: 125,
    ...(audioStreamIndex !== undefined ? { audioStreamIndex } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Strom v0.7.2: `builtin.mpegtssrt_input` without `map_audio_by_pid`. */
const MPEGTS_INPUT_V072 = {
  id: 'builtin.mpegtssrt_input',
  name: 'MPEG-TS/SRT Input',
  elements: [],
  links: [],
  exposed_properties: [{ name: 'num_video_tracks' }, { name: 'num_audio_tracks' }, { name: 'srt_uri' }, { name: 'latency' }],
};
/** Strom v0.8.0-alpha.1 (strom#1120): adds the opt-in `map_audio_by_pid`. */
const MPEGTS_INPUT_PID_ORDER = {
  ...MPEGTS_INPUT_V072,
  exposed_properties: [
    ...MPEGTS_INPUT_V072.exposed_properties,
    { name: 'map_audio_by_pid', property_type: 'Bool', default_value: false, live: false },
  ],
};

type BlocksResponse = { blocks: Record<string, unknown>[] } | Error;

function makeStromClient(blocksResponse: BlocksResponse = { blocks: [] }) {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: {
      list: blocksResponse instanceof Error
        ? vi.fn().mockRejectedValue(blocksResponse)
        : vi.fn().mockResolvedValue(blocksResponse),
    },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-test-123' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

function makeProduction(assignments: Array<{ sourceId: string; mixerInput: string }>) {
  return {
    _id: 'prod-audiostream',
    _rev: '1-abc',
    type: 'production',
    name: 'Audio Stream Production',
    status: 'inactive',
    sources: assignments,
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

type Block = Record<string, unknown>;
type Link = { from: string; to: string };

async function activateWith(
  source: ReturnType<typeof makeSource>,
  mixerInputs = ['video_in_1'],
  blocksResponse?: BlocksResponse,
) {
  sources.clear();
  sources.set(source._id, source);
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient(blocksResponse);
  const result = await activateStromFlow(
    makeProduction(mixerInputs.map((mixerInput) => ({ sourceId: source._id, mixerInput }))) as never,
    strom as never,
  );
  const flow = strom.capturedFlows[0]!;
  return {
    result,
    strom,
    blocks: flow['blocks'] as Block[],
    links: flow['links'] as Link[],
    elements: flow['elements'] as Block[],
  };
}

/** The SRT/EFP input block(s) and every link touching them — the part #516 may change. */
function inputShape(blocks: Block[], links: Link[]) {
  const inputBlocks = blocks.filter((b) =>
    ['builtin.mpegtssrt_input', 'builtin.efpsrt_input'].includes(b['block_definition_id'] as string),
  );
  const ids = new Set(inputBlocks.map((b) => b['id'] as string));
  const inputLinks = links.filter((l) => ids.has(l.from.split(':')[0]!) || ids.has(l.to.split(':')[0]!));
  return { inputBlocks, inputLinks };
}

describe('activateStromFlow — audio-stream selection clamp + warning (#516)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('k = 0 and absent build today\'s shape (audio_out_0, no num_audio_tracks) with no warning', async () => {
    const absent = await activateWith(makeSource('src-a', 'srt'));
    const zero = await activateWith(makeSource('src-a', 'srt', 0));

    const absentShape = inputShape(absent.blocks, absent.links);
    expect(absentShape.inputBlocks).toHaveLength(1);
    expect(absentShape.inputBlocks[0]!['properties']).toEqual({
      srt_uri: 'srt://192.0.2.10:9000?mode=caller',
      latency: 125,
    });
    expect(absentShape.inputLinks.map((l) => l.from).sort()).toEqual([
      expect.stringMatching(/:audio_out_0$/),
      expect.stringMatching(/:video_out$/),
    ]);
    expect(inputShape(zero.blocks, zero.links)).toEqual(absentShape);
    expect(absent.result.warnings).toEqual([]);
    expect(zero.result.warnings).toEqual([]);
  });

  it('srt with k = 1 clamps to audio_out_0 (byte-identical to k = 0) and warns strom-capability-missing', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const { result, blocks, links, strom } = await activateWith(makeSource('src-a', 'srt', 1));

    // Never wire an unordered audio_out_k (reintroduces #510).
    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(links.some((l) => /:audio_out_[1-9]/.test(l.from))).toBe(false);
    expect(blocks.some((b) => (b['properties'] as Record<string, unknown> | undefined)?.['num_audio_tracks'] !== undefined
      && b['block_definition_id'] === 'builtin.mpegtssrt_input')).toBe(false);
    // The block list was read (once) and has no mpegtssrt_input with map_audio_by_pid.
    expect(strom.blocks.list).toHaveBeenCalledTimes(1);

    expect(result.warnings).toEqual([
      {
        type: 'audio-stream-not-applied',
        sourceId: 'src-a',
        mixerInput: 'video_in_1',
        requestedIndex: 1,
        appliedIndex: 0,
        reason: 'strom-capability-missing',
        message: 'Cam src-a (SRT): audio stream 2 was not applied, using stream 1. '
          + 'This Strom cannot select an audio stream by PID yet.',
      },
    ]);
  });

  it('efp with k = 1 clamps and warns stream-type-unsupported', async () => {
    const baseline = await activateWith(makeSource('src-e', 'efp'));
    const { result, blocks, links } = await activateWith(makeSource('src-e', 'efp', 1));

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(inputShape(blocks, links).inputBlocks[0]!['block_definition_id']).toBe('builtin.efpsrt_input');
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: 'audio-stream-not-applied',
        sourceId: 'src-e',
        mixerInput: 'video_in_1',
        requestedIndex: 1,
        appliedIndex: 0,
        reason: 'stream-type-unsupported',
        message: expect.stringContaining('Cam src-e (EFP): audio stream 2 was not applied, using stream 1.'),
      }),
    ]);
  });

  it('srt with k = 9 (above the ceiling) clamps and warns stream-not-present', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const { result, blocks, links } = await activateWith(makeSource('src-a', 'srt', 9));

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: 'audio-stream-not-applied',
        requestedIndex: 9,
        appliedIndex: 0,
        reason: 'stream-not-present',
        message: expect.stringContaining('audio stream 10 was not applied, using stream 1.'),
      }),
    ]);
  });

  it('a source on two inputs yields one warning per input, keyed by the stored mixerInput', async () => {
    const { result } = await activateWith(makeSource('src-a', 'srt', 2), ['video_in_3', 'video_in_15']);

    const audioWarnings = result.warnings.filter((w) => w.type === 'audio-stream-not-applied');
    expect(audioWarnings).toHaveLength(2);
    expect(audioWarnings.map((w) => (w as { mixerInput: string }).mixerInput).sort()).toEqual([
      'video_in_15',
      'video_in_3',
    ]);
  });
});

describe('activateStromFlow — audio-stream selection applied on a PID-ordering Strom (#545)', () => {
  beforeEach(() => vi.clearAllMocks());
  const PID_STROM = { blocks: [MPEGTS_INPUT_PID_ORDER] };

  it('srt with k = 2: num_audio_tracks 3 + map_audio_by_pid, audio_out_2 selected, audio_out_0/1 each drained once', async () => {
    const { result, blocks, links, elements, strom } = await activateWith(makeSource('src-a', 'srt', 2), ['video_in_1'], PID_STROM);

    const { inputBlocks } = inputShape(blocks, links);
    expect(inputBlocks).toHaveLength(1);
    const inputId = inputBlocks[0]!['id'] as string;
    expect(inputBlocks[0]!['properties']).toEqual({
      srt_uri: 'srt://192.0.2.10:9000?mode=caller',
      latency: 125,
      num_audio_tracks: 3,
      map_audio_by_pid: true,
    });

    // The selected stream feeds the per-source audio offset; nothing else changes downstream.
    const selected = links.filter((l) => l.from === `${inputId}:audio_out_2`);
    expect(selected).toEqual([{ from: `${inputId}:audio_out_2`, to: expect.stringMatching(/^b-audio-offset-1-.*:in$/) }]);

    // Every unselected output is linked exactly once, each to its own fakesink drain.
    const drainIds: string[] = [];
    for (const j of [0, 1]) {
      const out = links.filter((l) => l.from === `${inputId}:audio_out_${j}`);
      expect(out).toHaveLength(1);
      const drainId = out[0]!.to.replace(/:sink$/, '');
      expect(drainId).toMatch(new RegExp(`^e-audio-drain-1-${j}-`));
      const drain = elements.find((e) => e['id'] === drainId)!;
      expect(drain['element_type']).toBe('fakesink');
      expect(drain['properties']).toEqual({ sync: false, async: false });
      drainIds.push(drainId);
    }
    expect(new Set(drainIds).size).toBe(2);
    expect(links.some((l) => /:audio_out_[3-9]$/.test(l.from))).toBe(false);

    expect(result.warnings).toEqual([]);
    expect(strom.blocks.list).toHaveBeenCalledTimes(1);
  });

  it('k = 0 stays byte-identical to today and does not read the block list', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const zero = await activateWith(makeSource('src-a', 'srt', 0), ['video_in_1'], PID_STROM);

    expect(inputShape(zero.blocks, zero.links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(zero.elements).toEqual(baseline.elements);
    expect(zero.elements.some((e) => String(e['id']).startsWith('e-audio-drain-'))).toBe(false);
    expect(zero.result.warnings).toEqual([]);
    expect(zero.strom.blocks.list).not.toHaveBeenCalled();
  });

  it('Strom v0.7.2 (no map_audio_by_pid) keeps the #544 clamp + strom-capability-missing', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const { result, blocks, links, elements } = await activateWith(
      makeSource('src-a', 'srt', 1), ['video_in_1'], { blocks: [MPEGTS_INPUT_V072] },
    );

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(elements).toEqual(baseline.elements);
    expect(result.warnings).toEqual([expect.objectContaining({ requestedIndex: 1, appliedIndex: 0, reason: 'strom-capability-missing' })]);
  });

  it('an unreadable block list is treated as capability missing (clamp, never an unordered audio_out_k)', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const { result, blocks, links } = await activateWith(
      makeSource('src-a', 'srt', 1), ['video_in_1'], new Error('strom unreachable'),
    );

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(result.warnings).toEqual([expect.objectContaining({ reason: 'strom-capability-missing' })]);
  });

  it('efp with k = 1 still clamps with stream-type-unsupported and does not probe Strom', async () => {
    const baseline = await activateWith(makeSource('src-e', 'efp'));
    const { result, blocks, links, strom } = await activateWith(makeSource('src-e', 'efp', 1), ['video_in_1'], PID_STROM);

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(result.warnings).toEqual([expect.objectContaining({ reason: 'stream-type-unsupported' })]);
    expect(strom.blocks.list).not.toHaveBeenCalled();
  });

  it('k = 8 (above the ceiling) still clamps with stream-not-present', async () => {
    const baseline = await activateWith(makeSource('src-a', 'srt'));
    const { result, blocks, links } = await activateWith(makeSource('src-a', 'srt', 8), ['video_in_1'], PID_STROM);

    expect(inputShape(blocks, links)).toEqual(inputShape(baseline.blocks, baseline.links));
    expect(result.warnings).toEqual([expect.objectContaining({ requestedIndex: 8, reason: 'stream-not-present' })]);
  });

  it('k = 7 (the ceiling) is applied: num_audio_tracks 8, seven drains', async () => {
    const { result, blocks, links, elements } = await activateWith(makeSource('src-a', 'srt', 7), ['video_in_1'], PID_STROM);

    const input = inputShape(blocks, links).inputBlocks[0]!;
    expect((input['properties'] as Record<string, unknown>)['num_audio_tracks']).toBe(8);
    expect(elements.filter((e) => String(e['id']).startsWith('e-audio-drain-1-'))).toHaveLength(7);
    expect(result.warnings).toEqual([]);
  });

  it('a source on two inputs is wired per input with distinct drains and one block-list read', async () => {
    const { result, blocks, links, elements, strom } = await activateWith(
      makeSource('src-a', 'srt', 1), ['video_in_3', 'video_in_15'], PID_STROM,
    );

    const { inputBlocks } = inputShape(blocks, links);
    expect(inputBlocks).toHaveLength(2);
    for (const b of inputBlocks) {
      const id = b['id'] as string;
      expect((b['properties'] as Record<string, unknown>)['num_audio_tracks']).toBe(2);
      expect(links.filter((l) => l.from === `${id}:audio_out_0`)).toEqual([{ from: `${id}:audio_out_0`, to: expect.stringMatching(/^e-audio-drain-\d+-0-.*:sink$/) }]);
      expect(links.filter((l) => l.from === `${id}:audio_out_1`)).toEqual([{ from: `${id}:audio_out_1`, to: expect.stringMatching(/^b-audio-offset-.*:in$/) }]);
    }
    const drains = elements.filter((e) => String(e['id']).startsWith('e-audio-drain-')).map((e) => e['id']);
    expect(new Set(drains).size).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(strom.blocks.list).toHaveBeenCalledTimes(1);
  });

  it('an ISO input recording taps the selected stream, not audio_out_0', async () => {
    sources.clear();
    sources.set('src-a', makeSource('src-a', 'srt', 2));
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient({
      blocks: [MPEGTS_INPUT_PID_ORDER, ...['builtin.recorder', 'builtin.audioenc', 'builtin.liverecorder'].map((id) => ({ id }))],
    });
    const prod = makeProduction([{ sourceId: 'src-a', mixerInput: 'video_in_1' }]);
    (prod.sources[0] as Record<string, unknown>)['record'] = 'transcode';
    await activateStromFlow(prod as never, strom as never, 'http://localhost:7000', [
      { _id: 'output-rec-iso12345', type: 'output', outputType: 'recording', name: 'VOD', createdAt: '', updatedAt: '' },
    ] as never);
    const flow = strom.capturedFlows[0]!;
    const links = flow['links'] as Link[];
    const inputId = inputShape(flow['blocks'] as Block[], links).inputBlocks[0]!['id'] as string;

    expect(links.filter((l) => l.from === `${inputId}:audio_out_2`).map((l) => l.to)).toEqual(expect.arrayContaining([
      expect.stringMatching(/^b-audio-offset-1-.*:in$/),
      expect.stringMatching(/^e-inrec-aq-1-.*:sink$/),
    ]));
    expect(links.filter((l) => l.from === `${inputId}:audio_out_0`)).toHaveLength(1);
    // Recorder choice and the audio capability share one block-list read.
    expect(strom.blocks.list).toHaveBeenCalledTimes(1);
  });
});

describe('stromMapsAudioByPid (spec §5.3 rule 3)', () => {
  it('is true only when builtin.mpegtssrt_input exposes map_audio_by_pid', async () => {
    const { stromMapsAudioByPid } = await import('../lib/flow-generator.js');
    expect(stromMapsAudioByPid(null)).toBe(false);
    expect(stromMapsAudioByPid([])).toBe(false);
    expect(stromMapsAudioByPid([{ id: 'builtin.mpegtssrt_input', name: 'x', elements: [], links: [] }])).toBe(false);
    expect(stromMapsAudioByPid([MPEGTS_INPUT_V072])).toBe(false);
    expect(stromMapsAudioByPid([{ ...MPEGTS_INPUT_PID_ORDER, id: 'builtin.efpsrt_input' }])).toBe(false);
    expect(stromMapsAudioByPid([MPEGTS_INPUT_PID_ORDER])).toBe(true);
  });
});

describe('audioStreamNotAppliedReason (spec §5.4)', () => {
  it('maps each case to the right reason', async () => {
    const { audioStreamNotAppliedReason, MAX_APPLIED_AUDIO_STREAM_INDEX } = await import('../lib/flow-generator.js');
    expect(audioStreamNotAppliedReason('srt', undefined, false)).toBeNull();
    expect(audioStreamNotAppliedReason('srt', 0, false)).toBeNull();
    expect(audioStreamNotAppliedReason('efp', 0, true)).toBeNull();
    expect(audioStreamNotAppliedReason('efp', 1, true)).toBe('stream-type-unsupported');
    expect(audioStreamNotAppliedReason('srt', 1, false)).toBe('strom-capability-missing');
    expect(audioStreamNotAppliedReason('srt', MAX_APPLIED_AUDIO_STREAM_INDEX, false)).toBe('strom-capability-missing');
    expect(audioStreamNotAppliedReason('srt', MAX_APPLIED_AUDIO_STREAM_INDEX + 1, true)).toBe('stream-not-present');
    // Capability present and in range → applied.
    expect(audioStreamNotAppliedReason('srt', 2, true)).toBeNull();
  });
});
