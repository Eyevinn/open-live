/**
 * Unit tests for the clip-source path in activateStromFlow (issue #276).
 *
 * On activate, every source whose streamType is 'clip' must inject a
 * builtin.media_player block into the Strom flow, and its block ID must be
 * returned in ActivationResult.clipPlayerBlockIds keyed by mixerInput —
 * mirroring the sourceOffsetBlockIds pattern.
 *
 * Strom client and CouchDB are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { serializeClipReference } from '../lib/clip-reference.js';

// ---------------------------------------------------------------------------
// Mock CouchDB — the sources DB returns a single 'clip' source keyed by id.
// ---------------------------------------------------------------------------

const clipSource = {
  _id: 'clip-src-1',
  _rev: '1-abc',
  type: 'source',
  name: 'Opening Clip',
  streamType: 'clip',
  status: 'active',
  // #275 stores the serialized ClipReference in the address field.
  address: serializeClipReference({ type: 'url', url: 'https://cdn.example.com/opening.mp4' }),
};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation((id: string) => {
      if (id === 'clip-src-1') return Promise.resolve({ ...clipSource });
      return Promise.reject(new Error('not found'));
    }),
  }),
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
        return Promise.resolve({ flow: { id: 'flow-clip-123' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
  return client;
}

function makeProduction(sources: Array<{ sourceId: string; mixerInput: string }>) {
  return {
    _id: 'prod-clip-only',
    _rev: '1-abc',
    type: 'production',
    name: 'Clip Production',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('activateStromFlow — clip sources (issue #276)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects a builtin.media_player block for a clip source and persists its id', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    const production = makeProduction([{ sourceId: 'clip-src-1', mixerInput: 'video_in_1' }]);

    const result = await activateStromFlow(production as never, strom as never);

    expect(strom.flows.create).toHaveBeenCalledOnce();
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const links = flow['links'] as Array<Record<string, unknown>>;

    // Exactly one media_player block must be injected.
    const players = blocks.filter((b) => b['block_definition_id'] === 'builtin.media_player');
    expect(players).toHaveLength(1);
    const player = players[0]!;

    // Its properties mirror the media_player definition.
    const props = player['properties'] as Record<string, unknown>;
    expect(props['decode']).toBe(true);
    expect(props['sync']).toBe(true);
    expect(props['loop_playlist']).toBe(false);
    expect(props['position_update_interval']).toBe(500);

    // The block id is persisted in clipPlayerBlockIds keyed by mixerInput.
    expect(result.clipPlayerBlockIds).toEqual({ video_in_1: player['id'] });

    // The player video pad feeds the source's time_offset block (same wiring as
    // every other source type), which in turn feeds the vision mixer.
    const playerId = player['id'] as string;
    const videoLink = links.find(
      (l) => l['from'] === `${playerId}:video_out`,
    );
    expect(videoLink).toBeDefined();
    expect(typeof videoLink!['to']).toBe('string');
    expect((videoLink!['to'] as string)).toContain(':in');
  });

  it('does not inject a media_player block when there are no clip sources', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();

    // Two test-pattern virtual sources — no clip sources.
    const production = makeProduction([
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
      { sourceId: '__test2__', mixerInput: 'video_in_2' },
    ]);

    const result = await activateStromFlow(production as never, strom as never);

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const players = blocks.filter((b) => b['block_definition_id'] === 'builtin.media_player');
    expect(players).toHaveLength(0);
    expect(result.clipPlayerBlockIds).toEqual({});
  });
});
