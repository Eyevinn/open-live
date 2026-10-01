/**
 * Flow-generator half of the issue #395 fix ("AUX pre/post setting is refused
 * by Strom on every change").
 *
 * `ch{N}_aux{M}_pre` is a build-time Strom block property (`live: false`) —
 * it can only be set when the flow is (re)built, never on a running pipeline.
 * controller.ts (see `aux-pre-post-persist.test.ts`) now persists a crew
 * AUX_SEND_SET `pre` choice as a per-channel override on the production doc's
 * `values` (`ch{N}_aux{M}_pre`) instead of attempting a live write. This test
 * verifies activateStromFlow applies that override at build time, taking
 * precedence over the existing per-bus (`aux{M}_pre`) / legacy
 * (`aux_pre_fader`) / default settings.
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
  sources: Array<{ sourceId: string; mixerInput: string }>,
  values?: Record<string, unknown>,
) {
  return {
    _id: 'prod-aux-pre-build',
    _rev: '1-abc',
    type: 'production',
    name: 'AUX Pre Flow Build Test',
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

describe('activateStromFlow — persisted AUX pre/post override (issue #395)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies a per-channel ch{N}_aux{M}_pre override, taking precedence over the per-bus setting', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: '__test2__', mixerInput: 'video_in_2' },
      ],
      {
        num_aux_buses: 1,
        aux1_pre: true, // per-bus default: pre-fader for every channel on aux 1
        ch2_aux1_pre: false, // crew override (persisted by controller.ts AUX_SEND_SET): ch2 is post-fader
      },
    );

    await activateStromFlow(production as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
    const props = auxMixer(blocks)['properties'] as Record<string, unknown>;

    // ch1 keeps the per-bus default (pre-fader); ch2's persisted override wins.
    expect(props['ch1_aux1_pre']).toBe(true);
    expect(props['ch2_aux1_pre']).toBe(false);
  });

  it('falls back to the per-bus setting, then the legacy key, then the pre-fader default when no override is persisted', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [{ sourceId: '__test1__', mixerInput: 'video_in_1' }],
      { num_aux_buses: 1, aux_pre_fader: false }, // legacy key only, no per-bus/per-channel keys
    );

    await activateStromFlow(production as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
    const props = auxMixer(blocks)['properties'] as Record<string, unknown>;

    expect(props['ch1_aux1_pre']).toBe(false);
  });

  it('persisted overrides for one aux bus do not bleed into another', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [{ sourceId: '__test1__', mixerInput: 'video_in_1' }],
      { num_aux_buses: 2, ch1_aux1_pre: false },
    );

    await activateStromFlow(production as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
    const props = auxMixer(blocks)['properties'] as Record<string, unknown>;

    expect(props['ch1_aux1_pre']).toBe(false);
    // aux2 has no override and no per-bus/legacy key → default pre-fader.
    expect(props['ch1_aux2_pre']).toBe(true);
  });
});
