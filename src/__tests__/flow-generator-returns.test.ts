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

describe('activateStromFlow — fast return feeds (returnFeed.lowLatency)', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeTwoFlowStrom(opts: { conversationStartFails?: boolean; existing?: Array<{ id: string; properties: Record<string, unknown> }> } = {}) {
    const created: Record<string, unknown>[] = [];
    return {
      flows: {
        list: vi.fn().mockResolvedValue({ flows: opts.existing ?? [] }),
        stop: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
          created.push(flow);
          return Promise.resolve({ flow: { id: created.length === 1 ? 'flow-program' : 'flow-conv' } });
        }),
        start: vi.fn().mockImplementation((id: string) =>
          id === 'flow-conv' && opts.conversationStartFails ? Promise.reject(new Error('no such block')) : Promise.resolve({})),
        delete: vi.fn().mockResolvedValue({}),
      },
      created,
    };
  }

  const guests = [
    { sourceId: '__test1__', mixerInput: 'video_in_0' },
    { sourceId: 'Whip', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' as const, lowLatency: true } },
    { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' as const } },
  ];

  it('taps every audio channel\'s direct out into a bridge and builds the mix-minus in a conversation flow', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeTwoFlowStrom();
    const result = await activateStromFlow(makeProduction(guests) as never, strom as never);

    expect(strom.created).toHaveLength(2);
    const program = strom.created[0]!;
    const pBlocks = program['blocks'] as Array<Record<string, unknown>>;
    const pLinks = program['links'] as Array<{ from: string; to: string }>;
    const mixer = auxMixer(pBlocks);
    const mixerId = mixer['id'] as string;
    expect((mixer['properties'] as Record<string, unknown>)['direct_outs']).toBe(true);

    // One bridge output per audio channel, fed from that channel's direct out
    // (1-based, like input_N), and from nothing else.
    const bridgeOuts = pBlocks.filter((b) => b['block_definition_id'] === 'builtin.audio_bridge_output');
    expect(bridgeOuts).toHaveLength(3);
    for (let ch = 0; ch < 3; ch++) {
      const bridge = bridgeOuts.find((b) => (b['properties'] as Record<string, unknown>)['channel'] === `fast-test-onl-${ch}`)!;
      expect(pLinks.filter((l) => l.to === `${bridge['id'] as string}:audio_in`))
        .toEqual([{ from: `${mixerId}:direct_out_${ch + 1}`, to: `${bridge['id'] as string}:audio_in` }]);
      // The bridge carries the channel the router's audio_in_<ch> expects.
      const bridgeIn = (strom.created[1]!['blocks'] as Array<Record<string, unknown>>)
        .find((b) => b['block_definition_id'] === 'builtin.audio_bridge_input' && (b['properties'] as Record<string, unknown>)['channel'] === `fast-test-onl-${ch}`)!;
      expect(bridgeIn['id']).toBe(`b-fast-bridge-in-${ch}-test-onl`);
    }

    const conv = strom.created[1]!;
    expect((conv['properties'] as Record<string, unknown>)['description']).toBe('conv:flow-program');
    const cBlocks = conv['blocks'] as Array<Record<string, unknown>>;
    const router = cBlocks.find((b) => b['block_definition_id'] === 'builtin.liveaudiorouter')!;
    const rp = router['properties'] as Record<string, unknown>;
    expect(rp['num_inputs']).toBe(3);
    expect(rp['num_outputs']).toBe(1);
    // video_in_1 is audio channel 1: its own voice is left out of its feed.
    expect(JSON.parse(rp['routing_matrix'] as string)).toEqual({
      i0c0: ['o0c0'], i0c1: ['o0c1'], i2c0: ['o0c0'], i2c1: ['o0c1'],
    });
    const fast = cBlocks.find((b) => b['block_definition_id'] === 'builtin.whep_output')!;
    expect(fast['properties']).toMatchObject({ endpoint_id: 'whep-fast-1-test-onl', num_audio_tracks: 1, num_video_tracks: 0 });

    // Only the lowLatency guest gets a fast feed; both keep their picture feed.
    expect(result.fastWhepEntries).toEqual([{ mixerInput: 'video_in_1', endpointId: 'whep-fast-1-test-onl' }]);
    expect(result.returnWhepEntries.map((e) => e.mixerInput)).toEqual(['video_in_1', 'video_in_2']);
    expect(result.fastFeedRouter).toEqual({ flowId: 'flow-conv', blockId: router['id'] });
  });

  it('removes a leftover conversation flow whose program flow is gone before creating its own', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeTwoFlowStrom({
      existing: [
        { id: 'flow-conv-leftover', properties: { description: 'conv:flow-gone' } },
        { id: 'flow-live', properties: { description: 'prod:prod-b' } },
        { id: 'flow-conv-live', properties: { description: 'conv:flow-live' } },
      ],
    });
    await activateStromFlow(makeProduction(guests) as never, strom as never);
    expect(strom.flows.delete.mock.calls.map((c) => c[0])).toEqual(['flow-conv-leftover']);
    const deleteOrder = strom.flows.delete.mock.invocationCallOrder[0]!;
    const convCreateOrder = strom.flows.create.mock.invocationCallOrder[1]!;
    expect(deleteOrder).toBeLessThan(convCreateOrder);
  });

  it('reads fast_return_latency_ms given as a number or a string', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    for (const value of [80, '80']) {
      const strom = makeTwoFlowStrom();
      await activateStromFlow(makeProduction(guests, { fast_return_latency_ms: value }) as never, strom as never);
      const bridges = (strom.created[1]!['blocks'] as Array<Record<string, unknown>>)
        .filter((b) => b['block_definition_id'] === 'builtin.audio_bridge_input');
      expect(bridges.map((b) => (b['properties'] as Record<string, unknown>)['target_latency_ms'])).toEqual([80, 80, 80]);
    }
  });

  it('builds no conversation flow when no guest asks for a fast feed', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeTwoFlowStrom();
    const result = await activateStromFlow(
      makeProduction(guests.map(({ returnFeed, ...g }) => (returnFeed ? { ...g, returnFeed: { synced: returnFeed.synced } } : g))) as never,
      strom as never,
    );
    expect(strom.created).toHaveLength(1);
    const blocks = strom.created[0]!['blocks'] as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b['block_definition_id'] === 'builtin.audio_bridge_output')).toBe(false);
    expect(auxMixer(blocks)['properties']).not.toHaveProperty('direct_outs');
    expect(result.fastWhepEntries).toEqual([]);
  });

  it('builds no fast feed past the router\'s 8 audio channels, and builds one at 8, with a fast feed on every channel', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const fast = { synced: 'program-minus' as const, lowLatency: true };
    const channels = (n: number, fastFrom: number) =>
      Array.from({ length: n }, (_, i) =>
        i + 1 >= fastFrom ? { sourceId: 'Whip', mixerInput: `video_in_${i + 1}`, returnFeed: fast } : { sourceId: '__test1__', mixerInput: `video_in_${i + 1}` });

    for (const sources of [channels(9, 9), channels(9, 1)]) {
      const strom = makeTwoFlowStrom();
      const result = await activateStromFlow(makeProduction(sources) as never, strom as never);
      expect(strom.created).toHaveLength(1);
      const blocks = strom.created[0]!['blocks'] as Array<Record<string, unknown>>;
      expect(blocks.some((b) => b['block_definition_id'] === 'builtin.audio_bridge_output')).toBe(false);
      expect(auxMixer(blocks)['properties']).not.toHaveProperty('direct_outs');
      expect(result.fastWhepEntries).toEqual([]);
    }

    const strom = makeTwoFlowStrom();
    const result = await activateStromFlow(makeProduction(channels(8, 1)) as never, strom as never);
    const router = (strom.created[1]!['blocks'] as Array<Record<string, unknown>>)
      .find((b) => b['block_definition_id'] === 'builtin.liveaudiorouter')!;
    expect(router['properties']).toMatchObject({ num_inputs: 8, num_outputs: 8 });
    expect(result.fastWhepEntries).toHaveLength(8);
  });

  it('keeps the program running when the conversation flow cannot start', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeTwoFlowStrom({ conversationStartFails: true });
    const result = await activateStromFlow(makeProduction(guests) as never, strom as never);
    expect(result.flowId).toBe('flow-program');
    expect(result.fastWhepEntries).toEqual([]);
    expect(result.fastFeedRouter).toBeUndefined();
    expect(strom.flows.delete).toHaveBeenCalledWith('flow-conv');
    expect(strom.flows.delete).not.toHaveBeenCalledWith('flow-program');
  });
});

describe('deactivateStromFlow — conversation flow', () => {
  it('removes the conversation flow of this program flow only', async () => {
    const { deactivateStromFlow } = await import('../lib/flow-generator.js');
    const strom = {
      flows: {
        list: vi.fn().mockResolvedValue({
          flows: [
            { id: 'flow-program', properties: { description: 'prod:prod-a' } },
            { id: 'flow-conv', properties: { description: 'conv:flow-program' } },
            { id: 'flow-other-conv', properties: { description: 'conv:flow-other' } },
          ],
        }),
        stop: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
    };
    await deactivateStromFlow('flow-program', strom as never);
    const deleted = strom.flows.delete.mock.calls.map((c) => c[0]);
    expect(deleted).toEqual(['flow-conv', 'flow-program']);
  });
});

describe('fastRoutingMatrix', () => {
  it('opens every other channel at unity in each output and closes only the guest\'s own', async () => {
    const { fastRoutingMatrix } = await import('../lib/fast-returns.js');
    // Outputs for guests on channels 1 and 2 of 3.
    expect(JSON.parse(fastRoutingMatrix(3, [1, 2]))).toEqual({
      i0c0: ['o0c0', 'o1c0'], i0c1: ['o0c1', 'o1c1'],
      i1c0: ['o1c0'], i1c1: ['o1c1'],
      i2c0: ['o0c0'], i2c1: ['o0c1'],
    });
  });
});
