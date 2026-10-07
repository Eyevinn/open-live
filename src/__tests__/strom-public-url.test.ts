/**
 * STROM_PUBLIC_URL: the WHEP URLs stored for browsers on an active production
 * use the public Strom base, server-only URLs stay on STROM_URL, and the WHEP
 * proxy maps public targets back to STROM_URL before forwarding.
 *
 * CouchDB, Strom client, and flow-generator are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../server.js';
import { config } from '../config.js';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockGet }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
  reinitConnectedControllers: vi.fn().mockResolvedValue(undefined),
}));

const mockActivateStromFlow = vi.fn();

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = {
      get: vi.fn().mockResolvedValue({ flow: { id: 'flow-1', running: true, blocks: [] } }),
    };
    mixer = {
      multiviewEndpoint: vi.fn().mockResolvedValue({ endpoint: '/whep/mv-ep' }),
    };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

const INTERNAL = 'http://b-strom:8080';
const PUBLIC = 'https://strom.example.com';

// `config` is `as const`; the tests switch the two Strom bases per case.
const cfg: { stromUrl: string; stromPublicUrl: string | undefined } = config;

const original = { stromUrl: cfg.stromUrl, stromPublicUrl: cfg.stromPublicUrl };

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue({ docs: [] });
  cfg.stromUrl = INTERNAL;
});

afterEach(() => {
  cfg.stromUrl = original.stromUrl;
  cfg.stromPublicUrl = original.stromPublicUrl;
  vi.unstubAllGlobals();
});

async function activate(): Promise<Record<string, unknown>> {
  let currentDoc: Record<string, unknown> = {
    _id: 'prod-test-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  mockGet.mockImplementation(async () => ({ ...currentDoc }));
  mockInsert.mockImplementation(async (d: Record<string, unknown>) => {
    currentDoc = { ...d };
    return { rev: 'rev-n', ok: true, id: d._id as string };
  });
  mockActivateStromFlow.mockResolvedValue({
    flowId: 'flow-1',
    mixerBlockId: 'mixer-1',
    whepOutputEntries: [{ outputId: 'out-1', endpointId: 'out-ep' }],
    pgmWhepEndpointId: 'pgm-ep',
    sourceOffsetBlockIds: {},
    sourceAudioOffsetBlockIds: {},
    clipPlayerBlockIds: {},
    returnBuses: [],
    returnWhepEntries: [{ mixerInput: 'video_in_1', endpointId: 'ret-ep' }],
    mixerInputMap: {},
  });

  const app = await buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/activate' });
  expect(res.statusCode).toBe(200);
  for (let i = 0; i < 50 && currentDoc.status !== 'active'; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(currentDoc.status).toBe('active');
  await app.close();
  return currentDoc;
}

describe('activation with STROM_PUBLIC_URL', () => {
  it('builds the browser-facing WHEP URLs on STROM_PUBLIC_URL', async () => {
    cfg.stromPublicUrl = PUBLIC;
    const doc = await activate();
    expect(doc.whepEndpoint).toBe(`${PUBLIC}/whep/mv-ep`);
    expect(doc.pgmWhepEndpoint).toBe(`${PUBLIC}/whep/pgm-ep`);
    expect(doc.whepOutputUrls).toEqual([{ outputId: 'out-1', url: `${PUBLIC}/whep/out-ep` }]);
    // Return feeds are fetched server-side only; they stay on STROM_URL.
    expect(doc.returnWhepUrls).toEqual([
      { mixerInput: 'video_in_1', url: `${INTERNAL}/whep/ret-ep`, endpointId: 'ret-ep' },
    ]);
  });

  it('falls back to STROM_URL when STROM_PUBLIC_URL is unset', async () => {
    cfg.stromPublicUrl = undefined;
    const doc = await activate();
    expect(doc.whepEndpoint).toBe(`${INTERNAL}/whep/mv-ep`);
    expect(doc.pgmWhepEndpoint).toBe(`${INTERNAL}/whep/pgm-ep`);
    expect(doc.whepOutputUrls).toEqual([{ outputId: 'out-1', url: `${INTERNAL}/whep/out-ep` }]);
  });
});

describe('WHEP proxy with STROM_PUBLIC_URL', () => {
  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('answer-sdp', { status: 201, headers: { Location: '/whep/pgm-ep/session-1' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('forwards a target on STROM_PUBLIC_URL to the same path on STROM_URL', async () => {
    cfg.stromPublicUrl = PUBLIC;
    const fetchMock = stubFetch();
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/whep-proxy?target=${encodeURIComponent(`${PUBLIC}/whep/pgm-ep`)}`,
      headers: { 'content-type': 'application/sdp' },
      payload: 'offer-sdp',
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(`${INTERNAL}/whep/pgm-ep`, expect.objectContaining({ method: 'POST' }));
    expect(res.headers['location']).toBe(
      `/api/v1/whep-proxy?target=${encodeURIComponent(`${INTERNAL}/whep/pgm-ep/session-1`)}`,
    );
  });

  it('still accepts a target on STROM_URL', async () => {
    cfg.stromPublicUrl = PUBLIC;
    const fetchMock = stubFetch();
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/whep-proxy?target=${encodeURIComponent(`${INTERNAL}/whep/pgm-ep`)}`,
      headers: { 'content-type': 'application/sdp' },
      payload: 'offer-sdp',
    });
    await app.close();
    expect(res.statusCode).toBe(201);
    expect(fetchMock).toHaveBeenCalledWith(`${INTERNAL}/whep/pgm-ep`, expect.anything());
  });

  it('rejects a host that only shares a prefix with STROM_PUBLIC_URL', async () => {
    cfg.stromPublicUrl = PUBLIC;
    const fetchMock = stubFetch();
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/whep-proxy?target=${encodeURIComponent(`${PUBLIC}.evil.com/whep/pgm-ep`)}`,
      headers: { 'content-type': 'application/sdp' },
      payload: 'offer-sdp',
    });
    await app.close();
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a public teardown target to STROM_URL', async () => {
    cfg.stromPublicUrl = PUBLIC;
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = await buildServer();
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/whep-proxy?target=${encodeURIComponent(`${PUBLIC}/whep/pgm-ep/session-1`)}`,
    });
    await app.close();
    expect(res.statusCode).toBe(204);
    expect(fetchMock).toHaveBeenCalledWith(`${INTERNAL}/whep/pgm-ep/session-1`, expect.objectContaining({ method: 'DELETE' }));
  });
});
