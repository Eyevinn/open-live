/**
 * Unit tests for guest-slot multiview labels in the flow generator (issue #458).
 *
 * The Studio controller labels a guest slot (a source assignment carrying a
 * `returnFeed`) "Guest 1"/"Guest 2", numbering them by trailing pad index
 * DESCENDING (slots are allocated from the top of the input range down, so the
 * highest index is Guest 1 — open-live-studio#171, TransitionPanel). The flow
 * generator must emit the matching `input_{N}_label` on the vision mixer so the
 * Strom multiviewer shows the same label instead of its default "In N+1".
 *
 * Strom client and CouchDB are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sourceDocs = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation(async (id: string) => {
      const doc = sourceDocs.get(id);
      if (!doc) throw new Error('not found');
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
  sources: Array<{ sourceId: string; mixerInput: string; returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean } }>,
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

describe('activateStromFlow — guest-slot multiview labels (#458)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceDocs.clear();
  });

  it('labels an unnamed WHIP guest slot "Guest N" instead of leaving it unset', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    // The single guest slot is Guest 1 — and the label must NOT be left unset
    // (which would make Strom fall back to its default "In 6" for video_in_5).
    expect(props['input_5_label']).toBe('Guest 1');
    expect(props['input_5_label']).not.toBe('WHIP Input');
  });

  it('numbers multiple guest slots by trailing pad index descending (controller convention)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_4', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    // Highest trailing index is Guest 1, next is Guest 2 (matches Studio's
    // top-of-range-down slot allocation).
    expect(props['input_5_label']).toBe('Guest 1');
    expect(props['input_4_label']).toBe('Guest 2');
  });

  it('keeps a named non-guest source label and does not label it "Guest N"', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    sourceDocs.set('src-cam', { _id: 'src-cam', type: 'source', name: 'Camera A', streamType: 'srt', address: 'srt://:5000?mode=listener' });
    const production = makeProduction([
      { sourceId: 'src-cam', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    expect(props['input_0_label']).toBe('Camera A');
    expect(props['input_5_label']).toBe('Guest 1');
  });

  it('does not apply the "Guest N" fallback to a WHIP input without a returnFeed (not a guest slot)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      // WHIP input with no returnFeed is an ordinary WHIP source, not a guest slot.
      { sourceId: 'Whip', mixerInput: 'video_in_1' },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    // Keeps the virtual WHIP source's own name, never a "Guest N" label.
    expect(props['input_1_label']).toBe('WHIP Input');
  });
});
