/**
 * Encoder wiring tests (issue #413).
 *
 * Program over WHEP arrived ~26 ms late because every WHEP viewer inherited
 * whepserversink's GCC pacing of the 10 Mbit/s `Enc PGM` encode. The fix adds a
 * shared low-bitrate `Enc View` encode (option iii) fed from the mixer's pgm_out,
 * and routes WHEP viewers + guest returns onto it while the recorder, RTMP and
 * SRT outputs stay on the full-rate `Enc PGM` encode.
 *
 * These tests pin which encoder feeds each consumer — no prior test covered it.
 * Strom + CouchDB are mocked.
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
    blocks: { list: vi.fn().mockResolvedValue({ blocks: [{ id: 'builtin.audioenc' }] }) },
    capturedFlows,
  };
}

function makeProduction(
  sources: Array<{ sourceId: string; mixerInput: string; returnFeed?: { synced: 'program' | 'program-minus'; lowLatency?: boolean } }>,
  values?: Record<string, unknown>,
) {
  return {
    _id: 'prod-enc-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Enc Production',
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

type Block = Record<string, unknown>;
type Link = Record<string, unknown>;

const byName = (blocks: Block[], name: string) =>
  blocks.find((b) => b['block_definition_id'] === 'builtin.videoenc' && b['name'] === name);

const feedFor = (links: Link[], blockId: string, pad = 'video_in') =>
  links.find((l) => l['to'] === `${blockId}:${pad}`);

const whepOutput = 'whep' as const;
const recordingOutput = 'recording' as const;

describe('flow-generator — viewer/program encoder split (#413)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('template adds an Enc View encode fed from the mixer pgm_out, feeding the static PGM WHEP output', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    await activateStromFlow(production as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Block[];
    const links = flow['links'] as Link[];

    const encView = byName(blocks, 'Enc View');
    const encPgm = byName(blocks, 'Enc PGM');
    expect(encView).toBeDefined();
    expect(encPgm).toBeDefined();
    // Default viewer encode is low-bitrate (~4 Mbit/s), program encode stays 10 Mbit/s.
    expect((encView!['properties'] as Block)['bitrate']).toBe(4000);
    expect((encPgm!['properties'] as Block)['bitrate']).toBe(10000);

    const mixer = blocks.find((b) => b['block_definition_id'] === 'builtin.vision_mixer')!;
    const mixerId = mixer['id'] as string;
    const encViewId = encView!['id'] as string;

    // Enc View is driven by the mixer's program output pad.
    expect(feedFor(links, encViewId)!['from']).toBe(`${mixerId}:pgm_out`);

    // The template's PGM WHEP output is fed from Enc View, not Enc PGM.
    const pgmWhep = blocks.find((b) => b['block_definition_id'] === 'builtin.whep_output' && b['name'] === 'PGM Output')!;
    const pgmWhepFeed = links.find((l) => l['to'] === `${pgmWhep['id'] as string}:video_in`)!;
    expect(pgmWhepFeed['from']).toBe(`${encViewId}:encoded_out`);
    expect(pgmWhepFeed['from']).not.toBe(`${encPgm!['id'] as string}:encoded_out`);
  });

  it('routes the recorder to Enc PGM and a WHEP output to Enc View', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    await activateStromFlow(production as never, strom as never, 'http://localhost:7000', [
      { _id: 'output-rec-abc12345', type: 'output', outputType: recordingOutput, name: 'VOD', createdAt: '', updatedAt: '' },
      { _id: 'output-whep-def67890', type: 'output', outputType: whepOutput, name: 'Viewer WHEP', createdAt: '', updatedAt: '' },
    ] as never);

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Block[];
    const links = flow['links'] as Link[];
    const encViewPad = `${byName(blocks, 'Enc View')!['id'] as string}:encoded_out`;
    const encPgmPad = `${byName(blocks, 'Enc PGM')!['id'] as string}:encoded_out`;

    // Recorder stays on the full-rate program encode.
    const recorder = blocks.find((b) => b['block_definition_id'] === 'builtin.recorder')!;
    expect(feedFor(links, recorder['id'] as string, 'video_in_0')!['from']).toBe(encPgmPad);

    // The dynamic WHEP viewer output is fed from the low-bitrate viewer encode.
    const whep = blocks.find((b) => b['block_definition_id'] === 'builtin.whep_output' && b['name'] === 'Viewer WHEP')!;
    expect(feedFor(links, whep['id'] as string)!['from']).toBe(encViewPad);
  });

  it('routes RTMP and SRT outputs to Enc PGM, not Enc View', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    await activateStromFlow(production as never, strom as never, 'http://localhost:7000', [
      { _id: 'output-srt-11112222', type: 'output', outputType: 'mpegtssrt', name: 'SRT Out', url: 'srt://example:6000', createdAt: '', updatedAt: '' },
    ] as never);

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Block[];
    const links = flow['links'] as Link[];
    const encPgmPad = `${byName(blocks, 'Enc PGM')!['id'] as string}:encoded_out`;

    const srt = blocks.find((b) => b['block_definition_id'] === 'builtin.mpegtssrt_output' && b['name'] === 'SRT Out')!;
    expect(feedFor(links, srt['id'] as string)!['from']).toBe(encPgmPad);
  });

  it('routes guest returns to Enc View', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction(
      [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: 'Whip', mixerInput: 'video_in_2', returnFeed: { synced: 'program' } },
      ],
      { num_aux_buses: 1 },
    );

    await activateStromFlow(production as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Block[];
    const links = flow['links'] as Link[];
    const encViewPad = `${byName(blocks, 'Enc View')!['id'] as string}:encoded_out`;

    const returnBlock = blocks.find(
      (b) => b['block_definition_id'] === 'builtin.whep_output' && String(b['name']).startsWith('Return ('),
    )!;
    expect(feedFor(links, returnBlock['id'] as string)!['from']).toBe(encViewPad);
  });

  it('applies viewer_bitrate to Enc View independently of bitrate/multiview_bitrate', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }], {
      bitrate: 8000,
      multiview_bitrate: 3000,
      viewer_bitrate: 2500,
    });

    await activateStromFlow(production as never, strom as never);
    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    expect((byName(blocks, 'Enc PGM')!['properties'] as Block)['bitrate']).toBe(8000);
    expect((byName(blocks, 'Enc MV')!['properties'] as Block)['bitrate']).toBe(3000);
    expect((byName(blocks, 'Enc View')!['properties'] as Block)['bitrate']).toBe(2500);
  });
});
