/**
 * AC2 of issue #633: activating a production whose `sources` holds an id with no
 * source doc drops that slot entirely and returns a `source-missing` activation
 * warning. It must not get a mixerInputMap entry, a mixer pad (num_inputs), a
 * multiview label or an input block — previously the slot kept a compacted pad,
 * so Strom drew a dead tile labelled with the raw source id.
 *
 * Strom client and CouchDB are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sourceDocs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation(async (id: string) => {
      const doc = sourceDocs.get(id);
      if (!doc) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return { ...doc };
    }),
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

function makeProduction(
  sources: Array<{ sourceId: string; mixerInput: string; returnFeed?: { synced: 'program' | 'program-minus' } }>,
) {
  return {
    _id: 'prod-test-only',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
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

function visionMixerProps(flow: Record<string, unknown>): Record<string, unknown> {
  const blocks = flow['blocks'] as Array<Record<string, unknown>>;
  const mixer = blocks.find((b) => b['block_definition_id'] === 'builtin.vision_mixer')!;
  return mixer['properties'] as Record<string, unknown>;
}

const GONE = 'src-b976c88b-bcae-4bec-b72f-b3d9617a6689';

describe('activateStromFlow — assignment whose source doc is gone (#633)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceDocs.clear();
    sourceDocs.set('src-cam', {
      _id: 'src-cam', type: 'source', name: 'Camera 1', streamType: 'srt', address: 'srt://127.0.0.1:9000?mode=caller',
    });
  });

  it('leaves the orphan slot out of mixerInputMap, num_inputs and labels, and warns', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: 'src-cam', mixerInput: 'video_in_0' },
      { sourceId: '__test1__', mixerInput: 'video_in_4' },
      { sourceId: GONE, mixerInput: 'video_in_5' },
    ]);

    const result = await activateStromFlow(production as never, strom as never);

    // Only the two live inputs are compacted; video_in_5 has no pad.
    expect(result.mixerInputMap).toEqual({ video_in_0: 0, video_in_4: 1 });

    const flow = strom.capturedFlows[0]!;
    const props = visionMixerProps(flow);
    expect(props['num_inputs']).toBe('2');
    expect(props['input_0_label']).toBe('Camera 1');
    expect(props['input_1_label']).toBeDefined();
    expect(props['input_2_label']).toBeUndefined();
    const labels = Object.entries(props).filter(([k]) => /^input_\d+_label$/.test(k)).map(([, v]) => String(v));
    expect(labels.some((l) => l.toLowerCase().includes('src-b976c88b'))).toBe(false);

    // No block for the orphan's stored pad, and nothing in the flow names the id.
    const blockIds = (flow['blocks'] as Array<Record<string, unknown>>).map((b) => String(b['id']));
    expect(blockIds.some((id) => id.startsWith('b-input-5-') || id.startsWith('b-offset-5-'))).toBe(false);
    expect(JSON.stringify(flow)).not.toContain(GONE);
    expect(result.sourceOffsetBlockIds).not.toHaveProperty('video_in_5');

    expect(result.warnings).toContainEqual({
      type: 'source-missing',
      mixerInput: 'video_in_5',
      sourceId: GONE,
      message: expect.stringContaining(GONE),
    });
  });

  it('keeps guest-slot numbering in step with the controller when an orphan is a return-feed slot', async () => {
    // guestSlotNumber counts every returnFeed assignment, orphans included, the
    // same way the controller's guest-slot-label.ts does, so a dropped orphan
    // guest slot must not renumber the guests that remain.
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const { guestSlotNumber } = await import('../lib/guest-slot-label.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: 'src-cam', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_14', returnFeed: { synced: 'program-minus' } },
      { sourceId: GONE, mixerInput: 'video_in_15', returnFeed: { synced: 'program-minus' } },
    ]);

    const result = await activateStromFlow(production as never, strom as never);

    expect(result.mixerInputMap).toEqual({ video_in_0: 0, video_in_14: 1 });
    // The orphan in video_in_15 still holds Guest 1, so the live guest is Guest 2
    // in both the flow's tile label and the controller's numbering.
    expect(guestSlotNumber(production as never, 'video_in_14')).toBe(2);
    expect(visionMixerProps(strom.capturedFlows[0]!)['input_1_label']).toBe('Guest 2 · In 15');
  });

  it('raises no source-missing warning when every source exists', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: 'src-cam', mixerInput: 'video_in_0' },
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
    ]);

    const result = await activateStromFlow(production as never, strom as never);

    expect(result.mixerInputMap).toEqual({ video_in_0: 0, video_in_1: 1 });
    expect(result.warnings.filter((w) => w.type === 'source-missing')).toEqual([]);
  });
});
