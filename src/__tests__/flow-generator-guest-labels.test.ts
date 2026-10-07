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

function audioMixerProps(flow: Record<string, unknown>): Record<string, unknown> {
  const blocks = flow['blocks'] as Array<Record<string, unknown>>;
  const mixer = blocks.find((b) => b['block_definition_id'] === 'builtin.mixer')!;
  return (mixer['properties'] ?? {}) as Record<string, unknown>;
}

/** Collects every `ch{N}_label` value set on the audio mixer block. */
function audioChannelLabels(flow: Record<string, unknown>): string[] {
  const props = audioMixerProps(flow);
  return Object.entries(props)
    .filter(([k]) => /^ch\d+_label$/.test(k))
    .map(([, v]) => v as string);
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

describe('activateStromFlow — guest-slot audio mixer strip labels (#464)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceDocs.clear();
  });

  it('labels a WHIP guest slot audio strip "Guest N", never the generic "WHIP Input"', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const labels = audioChannelLabels(strom.capturedFlows[0]!);
    // The audio strip for the guest slot must read "Guest 1", matching the
    // multiviewer tile — not the virtual source's generic "WHIP Input" name.
    expect(labels).toContain('Guest 1');
    expect(labels).not.toContain('WHIP Input');
  });

  it('numbers multiple guest-slot audio strips the same way as the multiviewer (pad index descending)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_4', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const flow = strom.capturedFlows[0]!;
    const visProps = visionMixerProps(flow);
    const audioLabels = audioChannelLabels(flow);
    // Highest trailing index is Guest 1, next is Guest 2 — identical to the
    // multiviewer's input_{N}_label numbering (the shared guestSlotNumber map).
    expect(visProps['input_5_label']).toBe('Guest 1');
    expect(visProps['input_4_label']).toBe('Guest 2');
    expect(audioLabels).toContain('Guest 1');
    expect(audioLabels).toContain('Guest 2');
    expect(audioLabels).not.toContain('WHIP Input');
  });

  it('keeps a named non-guest source audio strip label and does not label it "Guest N"', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    sourceDocs.set('src-cam', { _id: 'src-cam', type: 'source', name: 'Camera A', streamType: 'srt', address: 'srt://:5000?mode=listener' });
    const production = makeProduction([
      { sourceId: 'src-cam', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const labels = audioChannelLabels(strom.capturedFlows[0]!);
    expect(labels).toContain('Camera A');
    expect(labels).toContain('Guest 1');
  });

  it('does not apply the "Guest N" label to a WHIP audio strip without a returnFeed (not a guest slot)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      // WHIP input with no returnFeed is an ordinary WHIP source, not a guest slot.
      { sourceId: 'Whip', mixerInput: 'video_in_1' },
    ]);

    await activateStromFlow(production as never, strom as never);

    const labels = audioChannelLabels(strom.capturedFlows[0]!);
    // Keeps the virtual WHIP source's own name, never a "Guest N" label.
    expect(labels).toContain('WHIP Input');
    expect(labels).not.toContain('Guest 1');
  });
});

/**
 * Regression tests for issue #436 — "Guest picture never reaches the mixer".
 *
 * Guest slots are allocated from the top of the input range down (video_in_5,
 * video_in_4, …) while the live source count is usually small. Sizing the vision
 * mixer's `num_inputs` by the source COUNT alone left the guest's high-index pad
 * (e.g. video_in_5) uncreated — the mixer only has pads video_in_0 …
 * video_in_{num_inputs-1}. The whip_input → offset → mixer:video_in_5 link then
 * targeted a pad the mixer never had, so the guest's decoded picture dead-ended
 * and the slot tile stayed black even though WHIP negotiated (201). num_inputs
 * must be sized by the HIGHEST assigned pad index.
 */
describe('activateStromFlow — vision mixer num_inputs covers the highest pad index (#436)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sourceDocs.clear();
  });

  /** The numeric pad index every link into the vision mixer's video_in_N pads targets. */
  function mixerVideoInLinkIndices(flow: Record<string, unknown>): number[] {
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const mixerId = blocks.find((b) => b['block_definition_id'] === 'builtin.vision_mixer')!['id'] as string;
    const links = flow['links'] as Array<Record<string, unknown>>;
    return links
      .map((l) => {
        const m = new RegExp(`^${mixerId}:video_in_(\\d+)$`).exec((l['to'] as string | undefined) ?? '');
        return m ? parseInt(m[1], 10) : null;
      })
      .filter((n): n is number => n !== null);
  }

  it('sizes num_inputs for a sparse guest slot at video_in_5 (2 sources, count would under-provision)', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    // Before the fix this was "2" (pads video_in_0/video_in_1 only), so the
    // offset → mixer:video_in_5 link had no pad to connect to.
    const numInputs = parseInt(props['num_inputs'] as string, 10);
    expect(numInputs).toBeGreaterThanOrEqual(6);

    // Every generated link into the mixer must target a pad that now exists
    // (pads are video_in_0 … video_in_{num_inputs-1}).
    for (const idx of mixerVideoInLinkIndices(strom.capturedFlows[0]!)) {
      expect(idx).toBeLessThan(numInputs);
    }
  });

  it('covers the highest pad index with cameras at 0/1 and guests at 4/5', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    sourceDocs.set('src-a', { _id: 'src-a', type: 'source', name: 'Cam A', streamType: 'srt', address: 'srt://:5000?mode=listener' });
    sourceDocs.set('src-b', { _id: 'src-b', type: 'source', name: 'Cam B', streamType: 'srt', address: 'srt://:5001?mode=listener' });
    const production = makeProduction([
      { sourceId: 'src-a', mixerInput: 'video_in_0' },
      { sourceId: 'src-b', mixerInput: 'video_in_1' },
      { sourceId: 'Whip', mixerInput: 'video_in_4', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'Whip', mixerInput: 'video_in_5', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    const numInputs = parseInt(props['num_inputs'] as string, 10);
    // 4 sources would give num_inputs=4 (pads 0..3) — missing video_in_4/5.
    expect(numInputs).toBeGreaterThanOrEqual(6);
    for (const idx of mixerVideoInLinkIndices(strom.capturedFlows[0]!)) {
      expect(idx).toBeLessThan(numInputs);
    }
  });

  it('still produces an even, enum-valid num_inputs within the 2..16 range for contiguous sources', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_0' },
      { sourceId: '__test2__', mixerInput: 'video_in_1' },
      { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program-minus' } },
    ]);

    await activateStromFlow(production as never, strom as never);

    const props = visionMixerProps(strom.capturedFlows[0]!);
    const numInputs = parseInt(props['num_inputs'] as string, 10);
    // 3 sources at video_in_0..2 need pads 0..2 → rounded up to the even 4.
    expect(numInputs).toBe(4);
    for (const idx of mixerVideoInLinkIndices(strom.capturedFlows[0]!)) {
      expect(idx).toBeLessThan(numInputs);
    }
  });
});
