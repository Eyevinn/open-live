/**
 * The template's `Enc PGM` is the full-rate program encode that the recording, RTMP
 * and SRT outputs hang on. With none of those assigned nothing consumes it, so the
 * generator drops it (and its input link) instead of encoding the program at
 * 10 Mbit/s for nobody. Any output that uses it keeps it. WHEP viewers, guest
 * returns and the multiview never used it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(Object.assign(new Error('nf'), { statusCode: 404 })) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

type Block = Record<string, unknown>;
type Link = Record<string, unknown>;

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: { list: vi.fn().mockResolvedValue({ blocks: ['builtin.recorder', 'builtin.audioenc'].map((id) => ({ id })) }) },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-1' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

const production = {
  _id: 'prod-pgm-1', _rev: '1-a', type: 'production', name: 'P', status: 'inactive',
  sources: [{ sourceId: '__test1__', mixerInput: 'video_in_1' }],
  graphicAssignments: [], values: {}, pipeline: { stromConfig: null, status: 'stopped' },
  graphics: [], macros: [], tally: { pgm: null, pvw: null }, createdAt: '', updatedAt: '',
};

const output = (id: string, outputType: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, type: 'output', outputType, name: outputType, createdAt: '', updatedAt: '', ...extra });

async function activate(outputs: unknown[]) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient();
  await activateStromFlow(production as never, strom as never, 'http://localhost:7000', outputs as never);
  const flow = strom.capturedFlows[0]!;
  return { blocks: flow['blocks'] as Block[], links: flow['links'] as Link[] };
}

const enc = (blocks: Block[], name: string) =>
  blocks.find((b) => b['block_definition_id'] === 'builtin.videoenc' && b['name'] === name);
const touching = (links: Link[], id: string) =>
  links.filter((l) => String(l['from']).startsWith(`${id}:`) || String(l['to']).startsWith(`${id}:`));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('idle Enc PGM', () => {
  it('is dropped, with its input link, when no output uses it', async () => {
    const { blocks, links } = await activate([]);
    expect(enc(blocks, 'Enc PGM')).toBeUndefined();
    // Nothing is left pointing at the removed block, by id.
    expect(links.filter((l) => String(l['from']).includes('b370f5d3ce9774e869f262aa5714f7a74')
      || String(l['to']).includes('b370f5d3ce9774e869f262aa5714f7a74'))).toEqual([]);
  });

  it('leaves every other encoder and its wiring untouched', async () => {
    const { blocks, links } = await activate([]);
    for (const name of ['Enc View', 'Enc MV']) {
      const b = enc(blocks, name)!;
      expect(b).toBeDefined();
      expect(touching(links, b['id'] as string).length).toBeGreaterThanOrEqual(2); // fed and feeding
    }
  });

  it('does not touch a production whose WHEP output is the only one', async () => {
    const { blocks } = await activate([output('output-whep-def67890', 'whep')]);
    expect(enc(blocks, 'Enc PGM')).toBeUndefined();
    expect(enc(blocks, 'Enc View')).toBeDefined();
  });

  it('stays when a recording output uses it', async () => {
    const { blocks, links } = await activate([output('output-rec-abc12345', 'recording')]);
    const pgm = enc(blocks, 'Enc PGM')!;
    expect(pgm).toBeDefined();
    expect(links.some((l) => String(l['from']) === `${pgm['id'] as string}:encoded_out`)).toBe(true);
  });
});
