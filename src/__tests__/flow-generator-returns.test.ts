/**
 * Integration tests for per-guest return feeds in the flow generator
 * (epic #208, issue #300). Strom + CouchDB are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
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

function makeProduction(
  sources: Array<{ sourceId: string; mixerInput: string; returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean } }>,
  values?: Record<string, unknown>,
) {
  return {
    _id: 'prod-test-only',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources,
    graphicAssignments: [],
    values: values ?? {},
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const auxMixer = (blocks: Array<Record<string, unknown>>) =>
  blocks.find((b) => b['block_definition_id'] === 'builtin.mixer')!;

describe('activateStromFlow — per-guest return feeds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('numbers return buses after crew aux buses and grows num_aux_buses', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' } },
      ],
      { num_aux_buses: 2 },
    );

    const result = await activateStromFlow(production as never, strom as never);

    // Crew aux buses = 2 → the single return uses aux bus 3.
    expect(result.returnBuses).toHaveLength(1);
    expect(result.returnBuses[0]).toMatchObject({ mixerInput: 'video_in_2', auxBus: 3, mode: 'program-minus' });

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const mixer = auxMixer(blocks);
    // num_aux_buses = crew(2) + returns(1).
    expect((mixer['properties'] as Record<string, unknown>)['num_aux_buses']).toBe(3);
  });

  it('builds program-minus send matrix: own channel closed, others open, post-fader', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    // video_in_1 = ch0, video_in_2 = ch1 (guest, own channel = ch1).
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' } },
      ],
      { num_aux_buses: 0 },
    );

    await activateStromFlow(production as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
    const props = auxMixer(blocks)['properties'] as Record<string, unknown>;

    // Return uses aux bus 1 (no crew aux buses). Own channel (ch2, 1-based) closed.
    expect(props['ch1_aux1_level']).toBe(1.0);
    expect(props['ch2_aux1_level']).toBe(0.0);
    // Post-fader sends for the return bus.
    expect(props['ch1_aux1_pre']).toBe(false);
    expect(props['ch2_aux1_pre']).toBe(false);
  });

  it('adds one whep_output per guest with a single audio track fed from the return aux bus', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program' } },
      ],
      { num_aux_buses: 1 },
    );

    const result = await activateStromFlow(production as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const links = flow['links'] as Array<Record<string, unknown>>;

    expect(result.returnWhepEntries).toHaveLength(1);
    expect(result.returnWhepEntries[0]!.mixerInput).toBe('video_in_2');

    const returnBlock = blocks.find(
      (b) => b['block_definition_id'] === 'builtin.whep_output' && String(b['name']).startsWith('Return ('),
    );
    expect(returnBlock).toBeDefined();
    // Exactly one audio track on the return output.
    expect((returnBlock!['properties'] as Record<string, unknown>)['num_audio_tracks']).toBe(1);

    // Its single audio_in is fed from the return's aux bus (aux 2 = crew(1)+1).
    const mixerId = auxMixer(blocks)['id'] as string;
    const returnId = returnBlock!['id'] as string;
    const audioLink = links.find(
      (l) => l['to'] === `${returnId}:audio_in` && String(l['from']).startsWith(`${mixerId}:aux_out_`),
    );
    expect(audioLink).toBeDefined();
    expect(audioLink!['from']).toBe(`${mixerId}:aux_out_2`);
  });

  it('excludes return buses from the every-aux→every-WHEP fan-out (shared outputs cap at crew aux buses)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' } },
      ],
      { num_aux_buses: 1 },
    );

    await activateStromFlow(production as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const links = flow['links'] as Array<Record<string, unknown>>;
    const mixerId = auxMixer(blocks)['id'] as string;

    // The template PGM/MV WHEP outputs must NOT receive the return aux bus (aux 2).
    const sharedWhepIds = blocks
      .filter((b) => b['block_definition_id'] === 'builtin.whep_output' && !String(b['name']).startsWith('Return ('))
      .map((b) => b['id'] as string);
    for (const whepId of sharedWhepIds) {
      const feedsFromReturnBus = links.filter(
        (l) => String(l['to']).startsWith(`${whepId}:audio`) && l['from'] === `${mixerId}:aux_out_2`,
      );
      expect(feedsFromReturnBus).toHaveLength(0);
    }
  });

  it('is a no-op when no assignment carries a returnFeed', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
      { sourceId: 'Whip', mixerInput: 'video_in_2' },
    ]);

    const result = await activateStromFlow(production as never, strom as never);
    expect(result.returnBuses).toHaveLength(0);
    expect(result.returnWhepEntries).toHaveLength(0);
    const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
    const returnBlocks = blocks.filter(
      (b) => b['block_definition_id'] === 'builtin.whep_output' && String(b['name']).startsWith('Return ('),
    );
    expect(returnBlocks).toHaveLength(0);
  });
});
