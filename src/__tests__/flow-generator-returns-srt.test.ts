/**
 * A guest slot whose source is an SRT encoder (a phone on cellular, an
 * aid-station camera) gets the same return as a WHIP guest: its own aux bus,
 * with the SRT input's channel closed in program-minus. Strom + CouchDB mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SRT_SOURCE = {
  _id: 'src-srt-cam',
  type: 'source',
  name: 'Aid station cam',
  address: 'srt://0.0.0.0:9000?mode=listener',
  streamType: 'srt',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation((id: string) =>
      id === SRT_SOURCE._id ? Promise.resolve(SRT_SOURCE) : Promise.reject(new Error('not found')),
    ),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
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

function makeProduction(mode: 'program' | 'program-minus') {
  return {
    _id: 'prod-test-only',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_1' },
      { sourceId: SRT_SOURCE._id, mixerInput: 'video_in_2', returnFeed: { synced: mode } },
    ],
    graphicAssignments: [],
    values: { num_aux_buses: 0 },
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

describe('activateStromFlow — return on an SRT guest slot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds a return bus and a return WHEP output for the SRT input', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    const result = await activateStromFlow(makeProduction('program-minus') as never, strom as never);

    expect(result.returnBuses).toEqual([
      expect.objectContaining({ mixerInput: 'video_in_2', auxBus: 1, mode: 'program-minus' }),
    ]);
    expect(result.returnWhepEntries.map((e) => e.mixerInput)).toEqual(['video_in_2']);

    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    expect(blocks.some((b) => b['block_definition_id'] === 'builtin.mpegtssrt_input')).toBe(true);
    expect(
      blocks.some(
        (b) => b['block_definition_id'] === 'builtin.whep_output' && String(b['name']).startsWith('Return ('),
      ),
    ).toBe(true);
  });

  it('program-minus closes the send from the channel the SRT audio lands on', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    await activateStromFlow(makeProduction('program-minus') as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Block[];
    const links = flow['links'] as Link[];
    const mixer = blocks.find((b) => b['block_definition_id'] === 'builtin.mixer')!;
    const mixerId = mixer['id'] as string;
    const props = mixer['properties'] as Record<string, unknown>;

    // Find the mixer channel the SRT input's audio is wired into, rather than
    // assuming the numbering, so the test checks the channel actually excluded.
    const srtInput = blocks.find((b) => b['block_definition_id'] === 'builtin.mpegtssrt_input')!;
    const srtOffset = links.find((l) => l.from === `${srtInput['id'] as string}:audio_out_0`)!.to.split(':')[0];
    const srtChannelLink = links.find(
      (l) => l.from === `${srtOffset}:out` && l.to.startsWith(`${mixerId}:input_`),
    )!;
    const srtCh = Number(srtChannelLink.to.split('input_')[1]);
    const otherCh = srtCh === 1 ? 2 : 1;

    expect(props[`ch${srtCh}_aux1_level`]).toBe(0.0);
    expect(props[`ch${otherCh}_aux1_level`]).toBe(1.0);
  });

  it('program keeps the SRT input in its own return', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    await activateStromFlow(makeProduction('program') as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    const props = blocks.find((b) => b['block_definition_id'] === 'builtin.mixer')!['properties'] as Record<
      string,
      unknown
    >;

    expect(props['ch1_aux1_level']).toBe(1.0);
    expect(props['ch2_aux1_level']).toBe(1.0);
  });
});
