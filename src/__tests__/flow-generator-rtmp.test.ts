/**
 * Flow-generator tests for RTMP multi-destination (spec:
 * rtmp-multi-destination.md, ADR-004 Decision 3 / security condition 8).
 *
 * Asserts: one builtin.rtmp_output block per assigned rtmp output, the stream
 * key composed into rtmp_url ONLY at generation time, and that the composed
 * key-bearing URL never appears in any open-live log line — including the
 * flow-start-failure path (safeFlowProjection strips block properties).
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

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

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const STREAM_KEY = 'zzzz-secret-key-9999';
const originalEnv = { ...process.env };

let encryptStreamKey: typeof import('../lib/rtmp-credentials-crypto.js').encryptStreamKey;
let resetKeyCache: typeof import('../lib/srt-passphrase-crypto.js').resetKeyCache;

function makeStromClient(opts?: { failStart?: boolean }) {
  const capturedFlows: Record<string, unknown>[] = [];
  const client = {
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-test-123' } });
      }),
      start: opts?.failStart
        ? vi.fn().mockRejectedValue(new Error('boom'))
        : vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
  return client;
}

function makeProduction(outputAssignments: Array<{ outputId: string }>) {
  return {
    _id: 'prod-test-only', _rev: '1-abc', type: 'production', name: 'Test Production', status: 'inactive',
    sources: [{ sourceId: '__test1__', mixerInput: 'video_in_1' }],
    graphicAssignments: [], values: {}, pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [], macros: [], tally: { pgm: null, pvw: null }, outputAssignments,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function rtmpOutputDoc() {
  return {
    _id: 'output-yt', type: 'output', name: 'YT main', outputType: 'rtmp',
    rtmp: { platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeyEnc: encryptStreamKey(STREAM_KEY) },
    createdAt: '', updatedAt: '',
  };
}

beforeAll(async () => {
  process.env['RTMP_CREDENTIALS_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
  ({ encryptStreamKey } = await import('../lib/rtmp-credentials-crypto.js'));
  ({ resetKeyCache } = await import('../lib/srt-passphrase-crypto.js'));
});

afterAll(() => {
  process.env = { ...originalEnv };
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env['RTMP_CREDENTIALS_KEY'] = KEY_B64;
  resetKeyCache();
});

describe('activateStromFlow — RTMP output block', () => {
  it('emits one builtin.rtmp_output with rtmp_url composed from the decrypted key', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ outputId: 'output-yt' }]);

    await activateStromFlow(production as never, strom as never, undefined, [rtmpOutputDoc() as never]);

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const rtmpBlocks = blocks.filter((b) => b['block_definition_id'] === 'builtin.rtmp_output');
    expect(rtmpBlocks).toHaveLength(1);
    const props = rtmpBlocks[0]!['properties'] as Record<string, unknown>;
    expect(props['rtmp_url']).toBe(`rtmps://a.rtmp.youtube.com/live2/${STREAM_KEY}`);
  });

  it('never leaks the composed rtmp_url / key on the flow-start-failure log path', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient({ failStart: true });
    const production = makeProduction([{ outputId: 'output-yt' }]);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      activateStromFlow(production as never, strom as never, undefined, [rtmpOutputDoc() as never]),
    ).rejects.toThrow();

    // No console.error argument may contain the stream key or the composed URL.
    const logged = errorSpy.mock.calls.flat().map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join('\n');
    expect(logged).not.toContain(STREAM_KEY);
    expect(logged).not.toContain('rtmp_url');
    errorSpy.mockRestore();
  });
});
