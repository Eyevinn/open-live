/**
 * Regression: an SRT output's passphrase is stored encrypted (encv1:…, #260)
 * and must be decrypted before it reaches Strom's `srt_uri`. Sources were
 * decrypted in activateStromFlow; outputs went in raw, so Strom got the
 * ciphertext as the passphrase. Runs the real activateStromFlow with a real
 * at-rest-encrypted URL; only CouchDB and the Strom client are faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OutputDoc } from '../db/types.js';
import { encryptAddressPassphrase, isEncrypted, resetKeyCache } from '../lib/srt-passphrase-crypto.js';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const SECRET = 'supersecretpass';
const originalEnv = { ...process.env };

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

const PRODUCTION = {
  _id: 'prod-outpass',
  _rev: '1-abc',
  type: 'production',
  name: 'Output passphrase',
  status: 'inactive',
  sources: [],
  graphicAssignments: [],
  values: {},
  pipeline: { stromConfig: null, status: 'stopped' },
  graphics: [],
  macros: [],
  tally: { pgm: null, pvw: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function outputDoc(id: string, outputType: 'mpegtssrt' | 'efpsrt', url: string): OutputDoc {
  return { _id: id, type: 'output', name: id, outputType, url, createdAt: '', updatedAt: '' };
}

type Block = Record<string, unknown>;

describe('activateStromFlow — SRT output passphrase', () => {
  beforeEach(() => {
    resetKeyCache();
    process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
    delete process.env['NODE_ENV'];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    resetKeyCache();
  });

  it.each(['mpegtssrt', 'efpsrt'] as const)('decrypts the stored %s passphrase before it reaches srt_uri', async (outputType) => {
    const stored = encryptAddressPassphrase(`srt://:47100?mode=listener&passphrase=${SECRET}&latency=200`);
    expect(stored).toContain('passphrase=encv1:');
    const doc = outputDoc(`output-${outputType}`, outputType, stored);

    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    await activateStromFlow(PRODUCTION as never, strom as never, undefined, [doc]);

    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    const out = blocks.find((b) => b['name'] === doc.name)!;
    expect(out['block_definition_id']).toBe('builtin.mpegtssrt_output');
    const uri = (out['properties'] as Record<string, string>)['srt_uri']!;
    expect(uri).toBe(`srt://:47100?mode=listener&passphrase=${SECRET}&latency=200`);
    expect(uri).not.toContain('encv1:');
    // The caller's doc stays as stored.
    expect(isEncrypted(new URLSearchParams(doc.url!.split('?')[1]).get('passphrase')!)).toBe(true);
  });

  it('passes a legacy plaintext output passphrase through unchanged', async () => {
    const doc = outputDoc('output-legacy', 'mpegtssrt', `srt://example.com:9000?passphrase=${SECRET}`);
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    await activateStromFlow(PRODUCTION as never, strom as never, undefined, [doc]);
    const blocks = strom.capturedFlows[0]!['blocks'] as Block[];
    const out = blocks.find((b) => b['name'] === doc.name)!;
    expect((out['properties'] as Record<string, string>)['srt_uri']).toBe(`srt://example.com:9000?passphrase=${SECRET}`);
  });
});
