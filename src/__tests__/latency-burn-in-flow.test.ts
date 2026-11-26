/**
 * Latency burn-in — flow shape (src/lib/burn-in.ts):
 *  - off unless the production's `values.latency_burn_in` is true;
 *  - on: one builtin.reference_timestamp with burn-in right after each tapped input, before its time_offset,
 *    so nothing reaches the mixer without it;
 *  - the TAMS tap and the ISO recorder are built on the burned-in picture, not the plain input;
 *  - a Strom without the block, or an unreadable block list, leaves the flow as it was and says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const SOURCES: Record<string, Record<string, unknown>> = {
  'src-srt': { _id: 'src-srt', type: 'source', name: 'Camera 1', streamType: 'srt', address: 'srt://cam.example.com:9000?mode=caller', latency: 125 },
  'src-efp': { _id: 'src-efp', type: 'source', name: 'EFP Cam', streamType: 'efp', address: 'srt://cam2.example.com:9000?mode=caller' },
};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = SOURCES[id];
      if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { ...doc };
    }),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const ALL_BLOCKS = [
  'builtin.recorder', 'builtin.audioenc', 'builtin.liverecorder', 'builtin.videoenc', 'builtin.tams_output',
  'builtin.reference_timestamp',
];

function makeStromClient(blockIds: string[] | 'unreadable' = ALL_BLOCKS) {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    osc: { setPat: vi.fn().mockResolvedValue({}), clearPat: vi.fn().mockResolvedValue({}) },
    blocks: {
      list: blockIds === 'unreadable'
        ? vi.fn().mockRejectedValue(new Error('strom down'))
        : vi.fn().mockResolvedValue({ blocks: blockIds.map((id) => ({ id })) }),
    },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-bi-1' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

type Assignment = { sourceId: string; mixerInput: string; record?: 'transcode' };

function production(sources: Assignment[], values: Record<string, unknown> = {}) {
  return {
    _id: 'prod-bi-1', _rev: '1-abc', type: 'production', name: 'Burn-in Production', status: 'inactive',
    sources, graphicAssignments: [], values, pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [], macros: [], tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

type Flow = {
  blocks: Array<Record<string, unknown>>;
  elements: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
};

async function activate(
  sources: Assignment[],
  opts: { values?: Record<string, unknown>; blocks?: string[] | 'unreadable'; outputs?: unknown[] } = {},
) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient(opts.blocks);
  const result = await activateStromFlow(
    production(sources, opts.values) as never, strom as never, 'http://localhost:7000', (opts.outputs ?? []) as never,
  );
  return { result, flow: strom.capturedFlows[0] as unknown as Flow };
}

const burnBlocks = (flow: Flow) => flow.blocks.filter((b) => b['block_definition_id'] === 'builtin.reference_timestamp'
  && String(b['id']).startsWith('b-burnin-'));
const linkTo = (flow: Flow, to: string) => flow.links.find((l) => l['to'] === to);
const linksFrom = (flow: Flow, from: string) => flow.links.filter((l) => l['from'] === from).map((l) => String(l['to']));

const ON = { latency_burn_in: true };
const TWO: Assignment[] = [
  { sourceId: 'src-srt', mixerInput: 'video_in_1' },
  { sourceId: 'src-efp', mixerInput: 'video_in_2' },
];

const ENV = ['TAMS_GATEWAY_URL', 'TAMS_AUTH_MODE', 'OSC_ACCESS_TOKEN', 'OSC_PAT'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const n of ENV) delete process.env[n];
});
afterEach(() => {
  for (const n of ENV) delete process.env[n];
});

describe('off by default', () => {
  it('adds no burn-in block and no warning', async () => {
    const { result, flow } = await activate(TWO);
    expect(burnBlocks(flow)).toEqual([]);
    expect(result.warnings.filter((w) => w.type.startsWith('latency-'))).toEqual([]);
  });

  it('stays off for anything but true', async () => {
    for (const value of [false, 'true', 1]) {
      vi.resetModules();
      const { flow } = await activate(TWO, { values: { latency_burn_in: value } });
      expect(burnBlocks(flow)).toEqual([]);
    }
  });
});

describe('on', () => {
  it('stamps each tapped input with its time and burns it in, between the input and its offset', async () => {
    const { result, flow } = await activate(TWO, { values: ON });
    expect(burnBlocks(flow).map((b) => b['id'])).toEqual([
      expect.stringMatching(/^b-burnin-1-/),
      expect.stringMatching(/^b-burnin-2-/),
    ]);
    for (const b of burnBlocks(flow)) {
      expect(b['properties']).toMatchObject({ timescale: 'utc', burn_in: true });
      const n = String(b['id']).split('-')[2];
      const input = flow.blocks.find((x) => String(x['id']).startsWith(`b-input-${n}-`))!['id'] as string;
      const offset = flow.blocks.find((x) => String(x['id']).startsWith(`b-offset-${n}-`))!['id'] as string;
      expect(linkTo(flow, `${b['id']}:in`)!['from']).toBe(`${input}:video_out`);
      expect(linkTo(flow, `${offset}:in`)!['from']).toBe(`${b['id']}:out`);
      // Nothing reaches the offset (and so the mixers) without passing through the burn-in.
      expect(linksFrom(flow, `${input}:video_out`).filter((t) => t.startsWith(`${offset}:`))).toEqual([]);
    }
    expect(result.warnings.filter((w) => w.type.startsWith('latency-'))).toEqual([]);
  });

  it('feeds the TAMS tap and the ISO recorder from the burned-in picture', async () => {
    process.env['TAMS_GATEWAY_URL'] = 'https://tams.example.com';
    const outputs = [{ _id: 'output-rec-abc12345', type: 'output', outputType: 'recording', name: 'VOD', createdAt: '', updatedAt: '' }];
    const { flow } = await activate([{ ...TWO[0]!, record: 'transcode' }], { values: ON, outputs });
    const burn = burnBlocks(flow)[0]!['id'] as string;
    const queues = flow.elements.filter((e) => /^e-(tams|inrec)-vq-1-/.test(String(e['id'])));
    expect(queues).toHaveLength(2); // the TAMS tap and the ISO recorder
    for (const q of queues) expect(linkTo(flow, `${q['id']}:sink`)!['from']).toBe(`${burn}:out`);
  });

  it('leaves inputs without a tap alone', async () => {
    const { flow } = await activate([{ sourceId: '__test1__', mixerInput: 'video_in_1' }], { values: ON });
    expect(burnBlocks(flow)).toEqual([]);
  });
});

describe('Strom without the block', () => {
  it('leaves the flow as it was and warns, when builtin.reference_timestamp is missing', async () => {
    const { result, flow } = await activate(TWO, { values: ON, blocks: ['builtin.recorder', 'builtin.audioenc'] });
    expect(burnBlocks(flow)).toEqual([]);
    // The input still feeds its offset block directly, as without the option.
    const input = flow.blocks.find((x) => String(x['id']).startsWith('b-input-1-'))!['id'] as string;
    expect(linksFrom(flow, `${input}:video_out`).some((t) => t.startsWith('b-offset-1-'))).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'latency-burn-in-unavailable' }));
  });

  it('warns, rather than guess, when the block list cannot be read', async () => {
    const { result, flow } = await activate(TWO, { values: ON, blocks: 'unreadable' });
    expect(burnBlocks(flow)).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ type: 'latency-burn-in-unavailable' }));
  });
});
