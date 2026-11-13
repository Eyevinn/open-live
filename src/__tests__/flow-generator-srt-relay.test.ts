/**
 * Relay addresses (`srt+relay://<id>`) go into Strom's `srt_uri` as they are
 * (passphrase decrypted): Strom resolves the relay itself. They bind no port,
 * so they are never declared to Strom's port reservation for the flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OutputDoc } from '../db/types.js';
import { encryptAddressPassphrase, resetKeyCache } from '../lib/srt-passphrase-crypto.js';

const SECRET = 'supersecretpass';
const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const originalEnv = { ...process.env };

const sources: Record<string, unknown> = {};

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({
    get: vi.fn().mockImplementation((id: string) =>
      id in sources ? Promise.resolve({ ...(sources[id] as object) }) : Promise.reject(new Error('not found')),
    ),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const assignPortsToFlow = vi.fn();
vi.mock('../services/port-reservation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/port-reservation.js')>();
  return { ...actual, assignPortsToFlow: (...args: unknown[]) => assignPortsToFlow(...args) };
});

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-relay' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

function production(sourceIds: string[]) {
  return {
    _id: 'prod-relay',
    _rev: '1-abc',
    type: 'production',
    name: 'Relay',
    status: 'inactive',
    sources: sourceIds.map((sourceId, i) => ({ sourceId, mixerInput: `video_in_${i + 1}` })),
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
const srtUris = (blocks: Block[], def: string) =>
  blocks.filter((b) => b['block_definition_id'] === def).map((b) => (b['properties'] as Record<string, string>)['srt_uri']);

describe('activateStromFlow — SRT relay addresses', () => {
  beforeEach(() => {
    resetKeyCache();
    process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
    delete process.env['NODE_ENV'];
    assignPortsToFlow.mockReset();
    for (const k of Object.keys(sources)) delete sources[k];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    resetKeyCache();
  });

  it('passes relay addresses through to srt_uri (decrypted) and declares no ports for them', async () => {
    sources['src-relay'] = {
      _id: 'src-relay', type: 'source', name: 'Relay cam', streamType: 'srt', status: 'active',
      address: encryptAddressPassphrase(`srt+relay://cam-sticky?passphrase=${SECRET}&latency=200`),
      createdAt: '', updatedAt: '',
    };
    sources['src-listener'] = {
      _id: 'src-listener', type: 'source', name: 'Listener cam', streamType: 'srt', status: 'active',
      address: 'srt://:47105?mode=listener', createdAt: '', updatedAt: '',
    };
    const out: OutputDoc = {
      _id: 'output-relay', type: 'output', name: 'Relay out', outputType: 'mpegtssrt',
      url: encryptAddressPassphrase(`srt+relay://pgm-sticky?passphrase=${SECRET}`), createdAt: '', updatedAt: '',
    };

    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    await activateStromFlow(production(['src-relay', 'src-listener']) as never, strom as never, undefined, [out]);

    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    expect(srtUris(blocks, 'builtin.mpegtssrt_input')).toEqual(
      expect.arrayContaining([`srt+relay://cam-sticky?passphrase=${SECRET}&latency=200`, 'srt://:47105?mode=listener']),
    );
    expect(srtUris(blocks, 'builtin.mpegtssrt_output')).toEqual([`srt+relay://pgm-sticky?passphrase=${SECRET}`]);

    // Only the real listener port is declared to the reservation.
    expect(assignPortsToFlow).toHaveBeenCalledTimes(1);
    expect(assignPortsToFlow.mock.calls[0]![2]).toEqual([47105]);
  });

  it('the relay id survives every activation unchanged', async () => {
    sources['src-relay'] = {
      _id: 'src-relay', type: 'source', name: 'Relay cam', streamType: 'srt', status: 'active',
      address: 'srt+relay://cam-sticky', createdAt: '', updatedAt: '',
    };
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const uris: string[] = [];
    for (let i = 0; i < 2; i++) {
      const strom = makeStromClient();
      await activateStromFlow(production(['src-relay']) as never, strom as never);
      uris.push(...srtUris(strom.capturedFlows[0]!['blocks'] as Block[], 'builtin.mpegtssrt_input') as string[]);
    }
    expect(uris).toEqual(['srt+relay://cam-sticky', 'srt+relay://cam-sticky']);
  });
});
