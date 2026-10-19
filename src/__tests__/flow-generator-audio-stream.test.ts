/**
 * Audio-stream selection at activation (issue #516, spec
 * docs/specs/audio-stream-selection.md §5.3/§5.4, ADR-010).
 *
 * Until Strom maps `audio_out_<k>` by PID order (strom#1081) every
 * `audioStreamIndex > 0` is clamped to the first stream: the SRT/EFP input
 * block and its links stay byte-identical to the k = 0 shape, and one
 * `audio-stream-not-applied` warning is raised per affected mixer input.
 * Strom + CouchDB mocked.
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

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: { list: vi.fn().mockResolvedValue({ blocks: [] }) },
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

async function activateWith(source: ReturnType<typeof makeSource>, mixerInputs = ['video_in_1']) {
  sources.clear();
  sources.set(source._id, source);
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient();
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
    // The capability predicate is not defined upstream yet, so no Strom probe is made for it.
    expect(strom.blocks.list).not.toHaveBeenCalled();

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
    // Capability present and in range → applied (wiring gated on strom#1081).
    expect(audioStreamNotAppliedReason('srt', 2, true)).toBeNull();
  });
});
