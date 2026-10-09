/**
 * Issue #487 migration: switching the audio channel sort from lexical to numeric
 * pad order renumbers channels for productions with a guest (video_in_15) or 10+
 * sources. The per-channel pre/post settings persisted on the production doc
 * (`ch{N}_aux{M}_pre`) are keyed by channel number, so they must be remapped so
 * each operator setting follows its source instead of landing on a new one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const sourceDocs: Record<string, Record<string, unknown>> = {
  'cam-a': { _id: 'cam-a', type: 'source', name: 'A', streamType: 'srt', address: 'srt://1' },
  'cam-b': { _id: 'cam-b', type: 'source', name: 'B', streamType: 'srt', address: 'srt://2' },
  'cam-c': { _id: 'cam-c', type: 'source', name: 'C', streamType: 'srt', address: 'srt://3' },
  'cam-d': { _id: 'cam-d', type: 'source', name: 'D', streamType: 'srt', address: 'srt://4' },
  'cam-guest': { _id: 'cam-guest', type: 'source', name: 'Guest', streamType: 'srt', address: 'srt://5' },
};

let productions: Array<Record<string, unknown>> = [];
const inserted: Array<Record<string, unknown>> = [];
let migrationMarker: Record<string, unknown> | null = null;

vi.mock('../db/index.js', () => ({
  isDbConnected: () => true,
  getSourcesDb: () => ({
    get: (id: string) =>
      sourceDocs[id]
        ? Promise.resolve(sourceDocs[id])
        : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
  }),
  getDb: () => ({
    find: () => Promise.resolve({ docs: productions }),
    insert: (doc: Record<string, unknown>) => { inserted.push(doc); return Promise.resolve({ ok: true }); },
  }),
  getMigrationStateDb: () => ({
    get: () =>
      migrationMarker
        ? Promise.resolve(migrationMarker)
        : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
    insert: (doc: Record<string, unknown>) => { migrationMarker = doc; return Promise.resolve({ ok: true }); },
  }),
}));

const { migrateAudioChannelOrder, remapAuxPreValues } = await import('../services/migrate-audio-channel-order.js');
const { audioChannelRenumberMap } = await import('../lib/audio-channels.js');

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger;

function makeProduction(id: string, sources: Array<{ sourceId: string; mixerInput: string }>, values: Record<string, unknown>) {
  return { _id: id, _rev: '1-x', type: 'production', name: id, status: 'inactive', sources, values };
}

beforeEach(() => {
  productions = [];
  inserted.length = 0;
  migrationMarker = null;
  vi.clearAllMocks();
});

describe('audioChannelRenumberMap', () => {
  const resolveAll = (id: string) => (sourceDocs[id] ? id : undefined);

  it('maps old lexical channels to new numeric channels for a guest on video_in_15', () => {
    const remap = audioChannelRenumberMap(
      [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'cam-b', mixerInput: 'video_in_1' },
        { sourceId: 'cam-c', mixerInput: 'video_in_2' },
        { sourceId: 'cam-d', mixerInput: 'video_in_3' },
        { sourceId: 'cam-guest', mixerInput: 'video_in_15' },
      ],
      resolveAll,
    );
    // lexical: 0,1,15,2,3 → ch 1..5 ; numeric: 0,1,2,3,15 → ch 1..5.
    // So guest (old ch3) → ch5, video_in_2 (old ch4) → ch3, video_in_3 (old ch5) → ch4.
    expect(Object.fromEntries(remap)).toEqual({ 3: 5, 4: 3, 5: 4 });
  });

  it('is empty when every pad is < 10 and in order (lexical == numeric)', () => {
    const remap = audioChannelRenumberMap(
      [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'cam-b', mixerInput: 'video_in_1' },
        { sourceId: 'cam-c', mixerInput: 'video_in_2' },
      ],
      resolveAll,
    );
    expect(remap.size).toBe(0);
  });

  it('ignores unresolvable sources when numbering (they take no channel)', () => {
    const remap = audioChannelRenumberMap(
      [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'missing', mixerInput: 'video_in_1' },
        { sourceId: 'cam-guest', mixerInput: 'video_in_15' },
      ],
      resolveAll,
    );
    // Resolvable set is {0, 15}. lexical: 0,15 → ch1,ch2 ; numeric: 0,15 → ch1,ch2.
    expect(remap.size).toBe(0);
  });
});

describe('remapAuxPreValues', () => {
  it('renames only ch{N}_aux{M}_pre keys and leaves others untouched', () => {
    const next = remapAuxPreValues(
      { ch3_aux1_pre: false, ch4_aux1_pre: true, ch5_aux2_pre: false, aux1_pre: true, ch1_fader: 0.8 } as Record<string, string | number | boolean>,
      new Map([[3, 5], [4, 3], [5, 4]]),
    );
    expect(next).toEqual({ ch5_aux1_pre: false, ch3_aux1_pre: true, ch4_aux2_pre: false, aux1_pre: true, ch1_fader: 0.8 });
  });

  it('returns null when the remap changes nothing', () => {
    expect(remapAuxPreValues({ ch1_aux1_pre: false }, new Map())).toBeNull();
    expect(remapAuxPreValues({ ch1_aux1_pre: false }, new Map([[9, 10]]))).toBeNull();
  });
});

describe('migrateAudioChannelOrder', () => {
  it('migrates a guest production and records the marker', async () => {
    productions = [
      makeProduction('prod-guest', [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'cam-b', mixerInput: 'video_in_1' },
        { sourceId: 'cam-c', mixerInput: 'video_in_2' },
        { sourceId: 'cam-d', mixerInput: 'video_in_3' },
        { sourceId: 'cam-guest', mixerInput: 'video_in_15' },
      ], { ch3_aux1_pre: false, ch4_aux1_pre: true, ch5_aux2_pre: false }),
    ];

    await migrateAudioChannelOrder(log);

    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { values: Record<string, unknown> }).values).toEqual({
      ch5_aux1_pre: false, // guest followed from old ch3 to new ch5
      ch3_aux1_pre: true,  // video_in_2 from old ch4 to new ch3
      ch4_aux2_pre: false, // video_in_3 from old ch5 to new ch4
    });
    expect(migrationMarker).toMatchObject({ type: 'migration-state', migration: 'audio-channel-order-v2', migratedCount: 1 });
  });

  it('leaves contiguous low-pad productions untouched but still records the marker', async () => {
    productions = [
      makeProduction('prod-simple', [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'cam-b', mixerInput: 'video_in_1' },
      ], { ch1_aux1_pre: false, ch2_aux1_pre: true }),
    ];

    await migrateAudioChannelOrder(log);

    expect(inserted).toHaveLength(0);
    expect(migrationMarker).toMatchObject({ migratedCount: 0 });
  });

  it('is a no-op when the marker already exists (never double-migrates)', async () => {
    migrationMarker = { _id: 'migration:audio-channel-order-v2', type: 'migration-state', migration: 'audio-channel-order-v2' };
    productions = [
      makeProduction('prod-guest', [
        { sourceId: 'cam-a', mixerInput: 'video_in_0' },
        { sourceId: 'cam-guest', mixerInput: 'video_in_15' },
      ], { ch2_aux1_pre: false }),
    ];

    await migrateAudioChannelOrder(log);

    expect(inserted).toHaveLength(0);
  });
});
