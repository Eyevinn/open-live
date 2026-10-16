/**
 * Issue #527 (OL-25): REST audio processing routes
 *   GET  /api/v1/productions/:id/audio/:elementId/processing
 *   PATCH /api/v1/productions/:id/audio/:elementId/processing
 *
 * Asserts: GET returns Strom defaults overlaid by persisted changes; PATCH
 * range-validates, persists, writes the SAME live Strom props the WS path writes
 * (REST/WS parity), and broadcasts AUDIO_PROC_STATE applied:true. Uses the REAL
 * StromClient against a throwaway Strom HTTP server, like
 * `audio-rest-applied-broadcast.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';

const mockProductionGet = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ ok: true });
const broadcastMock = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockProductionGet, insert: mockInsert }),
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: broadcastMock };
});

const FLOW_ID = 'flow-proc-rest';
const AUDIO_BLOCK = 'b-audio-mixer-proc';
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
        flow: { id: FLOW_ID, blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }] },
      }));
      return;
    }
    if (req.method === 'PATCH') {
      patches.push({ path: url, body: body ?? {} });
      res.end(JSON.stringify({ properties: (body as { properties?: unknown })?.properties ?? {}, rejected: {} }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => stromServer.close());

const { default: audioRoutes } = await import('../routes/audio.js');

const PROD = 'prod-proc-rest';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Proc REST Test',
    status: 'active',
    stromFlowId: FLOW_ID,
    sources: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('REST audio processing routes (#527)', () => {
  beforeEach(() => {
    patches.length = 0;
    mockProductionGet.mockReset();
    mockProductionGet.mockResolvedValue(makeDoc());
    mockInsert.mockClear();
    broadcastMock.mockClear();
  });

  it('GET returns Strom defaults for an untouched channel', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/audio/ch1/processing` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.element_id).toBe('ch1');
    expect(Object.keys(body.processing).sort()).toEqual(['comp', 'eq', 'gain', 'gate', 'hpf']);
    expect(body.processing.comp).toMatchObject({ enabled: false, ratio: 4, threshold: -20 });
    expect(body.processing.gain).toEqual({ gain: 0 });
    await app.close();
  });

  it('GET for main returns comp/eq/limiter only, with persisted changes overlaid', async () => {
    mockProductionGet.mockResolvedValue(makeDoc({ audioProcessing: { main: { limiter: { enabled: true, threshold: -6 } } } }));
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${PROD}/audio/main/processing` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.processing).sort()).toEqual(['comp', 'eq', 'limiter']);
    expect(body.processing.limiter).toEqual({ enabled: true, threshold: -6 });
    await app.close();
  });

  it('PATCH persists, writes the live Strom props and broadcasts applied AUDIO_PROC_STATE', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1/processing`,
      payload: { stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ element_id: 'ch1', stage: 'comp', applied: true });
    // Persisted
    expect(mockInsert).toHaveBeenCalled();
    // REST/WS parity: same live Strom keys the WS path writes
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe(`/api/flows/${FLOW_ID}/blocks/${AUDIO_BLOCK}/properties`);
    expect(patches[0].body).toEqual({ properties: { ch1_comp_enabled: true, ch1_comp_threshold: -24, ch1_comp_ratio: 4 } });
    // Broadcast
    expect(broadcastMock).toHaveBeenCalledWith(PROD, {
      type: 'AUDIO_PROC_STATE', elementId: 'ch1', stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 }, applied: true,
    });
    await app.close();
  });

  it('PATCH rejects an out-of-range value with 400 and writes nothing to Strom', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1/processing`,
      payload: { stage: 'comp', params: { ratio: 50 } },
    });
    expect(res.statusCode).toBe(400);
    expect(patches).toHaveLength(0);
    expect(broadcastMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('PATCH rejects a stage not valid on the element with 400', async () => {
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1/processing`,
      payload: { stage: 'limiter', params: { enabled: true } },
    });
    expect(res.statusCode).toBe(400);
    expect(patches).toHaveLength(0);
    await app.close();
  });

  it('PATCH when inactive persists and returns applied:false (applies on next activation)', async () => {
    mockProductionGet.mockResolvedValue(makeDoc({ stromFlowId: undefined, status: 'inactive' }));
    const app = Fastify();
    await app.register(audioRoutes);
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch2/processing`,
      payload: { stage: 'hpf', params: { enabled: true, freq: 120 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: false });
    expect(patches).toHaveLength(0);
    expect(mockInsert).toHaveBeenCalled();
    await app.close();
  });
});
