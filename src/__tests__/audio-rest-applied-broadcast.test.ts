/**
 * Issue #453: PATCH /api/v1/productions/:id/audio/:elementId wrote the fader /
 * mute value to Strom but broadcast nothing, so controller clients watching the
 * WS never learned about a mix change made over REST and went stale.
 *
 * Fix: after the Strom write succeeds, the route broadcasts an AUDIO_STATE frame
 * (same shape the WS mixer path uses) marked `applied: true`.
 *
 * Uses the REAL StromClient against a throwaway Strom HTTP server, as
 * `audio-channel-numbering.test.ts` does; CouchDB and `broadcast` are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

const mockProductionGet = vi.fn();
const broadcastMock = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockProductionGet, insert: vi.fn().mockResolvedValue({ ok: true }) }),
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: broadcastMock };
});

const FLOW_ID = 'flow-rest-applied';
const AUDIO_BLOCK = 'b-audio-mixer-0';
const patches: Array<{ path: string; body: Record<string, unknown> }> = [];

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    const url = req.url ?? '';
    if (req.method === 'GET' && url === `/api/flows/${FLOW_ID}`) {
      res.end(JSON.stringify({
        flow: {
          id: FLOW_ID,
          blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }],
        },
      }));
      return;
    }
    if (req.method === 'PATCH') {
      patches.push({ path: url, body: body ?? {} });
      res.end(JSON.stringify({ properties: body ?? {} }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => {
  stromServer.close();
});

const { default: audioRoutes } = await import('../routes/audio.js');

const PROD = 'prod-rest-applied';

function makeDoc() {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'REST Applied Test',
    status: 'active',
    stromFlowId: FLOW_ID,
    sources: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('PATCH /audio/:elementId broadcasts applied AUDIO_STATE (issue #453)', () => {
  beforeEach(() => {
    patches.length = 0;
    mockProductionGet.mockReset();
    mockProductionGet.mockResolvedValue(makeDoc());
    broadcastMock.mockClear();
  });

  it('broadcasts an applied volume AUDIO_STATE after writing to Strom', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1`,
      payload: { property: 'volume', value: 0.5 },
    });
    expect(res.statusCode).toBe(200);
    expect(patches).toHaveLength(1);
    expect(broadcastMock).toHaveBeenCalledWith(PROD, {
      type: 'AUDIO_STATE',
      elementId: 'ch1',
      property: 'volume',
      value: 0.5,
      applied: true,
    });
    await app.close();
  });

  it('broadcasts an applied mute AUDIO_STATE after writing to Strom', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/main`,
      payload: { property: 'mute', value: true },
    });
    expect(res.statusCode).toBe(200);
    expect(broadcastMock).toHaveBeenCalledWith(PROD, {
      type: 'AUDIO_STATE',
      elementId: 'main',
      property: 'mute',
      value: true,
      applied: true,
    });
    await app.close();
  });

  it('does not broadcast when the pipeline is not active (409)', async () => {
    mockProductionGet.mockResolvedValue({ ...makeDoc(), stromFlowId: undefined });
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1`,
      payload: { property: 'volume', value: 0.5 },
    });
    expect(res.statusCode).toBe(409);
    expect(broadcastMock).not.toHaveBeenCalled();
    await app.close();
  });
});
