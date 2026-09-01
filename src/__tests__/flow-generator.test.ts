/**
 * Unit tests for activateStromFlow in flow-generator.ts.
 *
 * Strom client and CouchDB are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  const client = {
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
  return client;
}

function makeProduction(sources: Array<{ sourceId: string; mixerInput: string }>, values?: Record<string, unknown>) {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activateStromFlow — test pattern sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds one audiotestsrc per test pattern and sets num_channels correctly (test-only production)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
      { sourceId: '__test2__', mixerInput: 'video_in_2' },
    ]);

    await activateStromFlow(production as never, strom as never);

    expect(strom.flows.create).toHaveBeenCalledOnce();
    const flow = strom.capturedFlows[0]!;
    const elements = flow['elements'] as Array<Record<string, unknown>>;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const links = flow['links'] as Array<Record<string, unknown>>;

    // Each test pattern should have one audiotestsrc element
    const audioTestSrcs = elements.filter((e) => e['element_type'] === 'audiotestsrc');
    expect(audioTestSrcs).toHaveLength(2);
    for (const e of audioTestSrcs) {
      expect((e['properties'] as Record<string, unknown>)['wave']).toBe('silence');
    }

    // Audio mixer must have num_channels = 2 (one per test pattern)
    const audioMixer = blocks.find((b) => b['block_definition_id'] === 'builtin.mixer');
    expect(audioMixer).toBeDefined();
    expect((audioMixer!['properties'] as Record<string, unknown>)['num_channels']).toBe(2);

    // Each audiotestsrc must be linked into the audio mixer
    const audioMixerId = audioMixer!['id'] as string;
    const linksToAudioMixer = links.filter(
      (l) => typeof l['to'] === 'string' && (l['to'] as string).startsWith(`${audioMixerId}:input_`),
    );
    expect(linksToAudioMixer).toHaveLength(2);
  });

  it('includes test patterns in audio channel count even alongside other virtual sources', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    // Both test1 and test2 virtual sources — no DB lookup needed
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
      { sourceId: '__test2__', mixerInput: 'video_in_2' },
      { sourceId: 'Whip', mixerInput: 'video_in_3' },
    ]);

    await activateStromFlow(production as never, strom as never);

    const flow = strom.capturedFlows[0]!;
    const elements = flow['elements'] as Array<Record<string, unknown>>;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;

    // Two test patterns → two audiotestsrc elements
    const audioTestSrcs = elements.filter((e) => e['element_type'] === 'audiotestsrc');
    expect(audioTestSrcs).toHaveLength(2);

    // num_channels = 3 (test1 + test2 + WHIP)
    const audioMixer = blocks.find((b) => b['block_definition_id'] === 'builtin.mixer');
    expect((audioMixer!['properties'] as Record<string, unknown>)['num_channels']).toBe(3);
  });

  it('returns flow successfully without throwing for a test-pattern-only production', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
    ]);

    await expect(activateStromFlow(production as never, strom as never)).resolves.toMatchObject({
      flowId: 'flow-test-123',
    });
  });
});
