/**
 * Commentator preview in the flow generator (`docs/specs/guest-calling-intercom.md`
 * §"Commentator preview"): a source assignment marked `commentatorPreview` gets
 * its own encoder + WHEP output fed from the input block's RAW pads — before the
 * source's time_offset blocks and outside the mixer — so a commentator can watch
 * the source undelayed. Strom + CouchDB are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const SOURCES: Record<string, Record<string, unknown>> = {
  'src-srt': { _id: 'src-srt', type: 'source', name: 'Stadium cam', address: 'srt://0.0.0.0:9000?mode=listener', streamType: 'srt' },
  'src-efp': { _id: 'src-efp', type: 'source', name: 'Tunnel cam', address: 'srt://0.0.0.0:9001?mode=listener', streamType: 'efp' },
  'src-html': { _id: 'src-html', type: 'source', name: 'Score bug', address: 'https://example.com/bug', streamType: 'html' },
};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation((id: string) =>
      SOURCES[id] ? Promise.resolve({ ...SOURCES[id] }) : Promise.reject(new Error('not found')),
    ),
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
  sources: Array<{ sourceId: string; mixerInput: string; commentatorPreview?: boolean; returnFeed?: { synced: 'program-minus' } }>,
) {
  return {
    _id: 'prod-abcdef12-rest',
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

type Block = Record<string, unknown>;
type Link = { from: string; to: string };

async function generate(sources: Parameters<typeof makeProduction>[0]) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient();
  const result = await activateStromFlow(makeProduction(sources) as never, strom as never);
  const flow = strom.capturedFlows[0]!;
  return { result, blocks: flow['blocks'] as Block[], links: flow['links'] as Link[] };
}

const previewOutputs = (blocks: Block[]) =>
  blocks.filter((b) => b['block_definition_id'] === 'builtin.whep_output' && String(b['name']).startsWith('Preview ('));

describe('activateStromFlow — commentator preview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds an encoder + WHEP output fed from the SRT input raw pads, not the offset blocks', async () => {
    const { result, blocks, links } = await generate([
      { sourceId: 'src-srt', mixerInput: 'video_in_0', commentatorPreview: true },
      { sourceId: '__test1__', mixerInput: 'video_in_1' },
    ]);

    const outputs = previewOutputs(blocks);
    expect(outputs).toHaveLength(1);
    const whep = outputs[0]!;
    expect(whep['properties']).toEqual({
      endpoint_id: 'whep-preview-0-abcdef12',
      low_latency: true,
      mode: 'audio_video',
      num_audio_tracks: 1,
    });
    expect(result.previewWhepEntries).toEqual([{ mixerInput: 'video_in_0', endpointId: 'whep-preview-0-abcdef12' }]);

    const inputId = blocks.find((b) => b['block_definition_id'] === 'builtin.mpegtssrt_input')!['id'] as string;
    const whepId = whep['id'] as string;

    // Video: input:video_out → preview encoder → WHEP video_in.
    const enc = blocks.find((b) => b['block_definition_id'] === 'builtin.videoenc' && b['name'] === 'Enc Preview (video_in_0)')!;
    expect(enc['properties']).toEqual({ bitrate: 4000 });
    const encId = enc['id'] as string;
    expect(links).toContainEqual({ from: `${inputId}:video_out`, to: `${encId}:video_in` });
    expect(links).toContainEqual({ from: `${encId}:encoded_out`, to: `${whepId}:video_in` });

    // Audio: the input's own first track, straight to the WHEP output.
    expect(links).toContainEqual({ from: `${inputId}:audio_out_0`, to: `${whepId}:audio_in` });

    // The raw pads still feed the offset blocks too (fan-out, unchanged).
    expect(links).toContainEqual({ from: `${inputId}:video_out`, to: `${result.sourceOffsetBlockIds['video_in_0']}:in` });
    expect(links).toContainEqual({ from: `${inputId}:audio_out_0`, to: `${result.sourceAudioOffsetBlockIds['video_in_0']}:in` });

    // Nothing feeding the preview comes from an offset block or the mixers.
    const offsetIds = new Set(blocks.filter((b) => b['block_definition_id'] === 'builtin.time_offset').map((b) => b['id'] as string));
    const intoPreview = links.filter((l) => l.to.startsWith(`${whepId}:`) || l.to.startsWith(`${encId}:`));
    expect(intoPreview).toHaveLength(3);
    for (const l of intoPreview) {
      expect(offsetIds.has(l.from.split(':')[0]!)).toBe(false);
    }
  });

  it('covers EFP inputs and keys endpoint ids by the stored pad index', async () => {
    const { result, blocks, links } = await generate([
      { sourceId: 'src-srt', mixerInput: 'video_in_0', commentatorPreview: true },
      { sourceId: 'src-efp', mixerInput: 'video_in_3', commentatorPreview: true },
    ]);
    expect(result.previewWhepEntries).toEqual([
      { mixerInput: 'video_in_0', endpointId: 'whep-preview-0-abcdef12' },
      { mixerInput: 'video_in_3', endpointId: 'whep-preview-3-abcdef12' },
    ]);
    const efpId = blocks.find((b) => b['block_definition_id'] === 'builtin.efpsrt_input')!['id'] as string;
    const efpWhep = previewOutputs(blocks).find((b) => b['name'] === 'Preview (video_in_3)')!;
    expect(links).toContainEqual({ from: `${efpId}:audio_out_0`, to: `${efpWhep['id'] as string}:audio_in` });
  });

  it('adds nothing for unflagged sources', async () => {
    const { result, blocks } = await generate([
      { sourceId: 'src-srt', mixerInput: 'video_in_0' },
      { sourceId: 'src-efp', mixerInput: 'video_in_1', commentatorPreview: false },
    ]);
    expect(previewOutputs(blocks)).toHaveLength(0);
    expect(blocks.some((b) => String(b['name']).startsWith('Enc Preview'))).toBe(false);
    expect(result.previewWhepEntries).toEqual([]);
  });

  it('ignores the flag on source kinds without a raw input block (WHIP, HTML, test patterns)', async () => {
    const { result, blocks } = await generate([
      { sourceId: 'Whip', mixerInput: 'video_in_0', commentatorPreview: true, returnFeed: { synced: 'program-minus' } },
      { sourceId: 'src-html', mixerInput: 'video_in_1', commentatorPreview: true },
      { sourceId: '__test1__', mixerInput: 'video_in_2', commentatorPreview: true },
    ]);
    expect(previewOutputs(blocks)).toHaveLength(0);
    expect(result.previewWhepEntries).toEqual([]);
  });
});
