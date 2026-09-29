/**
 * Route tests for RTMP multi-destination outputs (spec:
 * rtmp-multi-destination.md, ADR-004). Exercises the security conditions:
 *   1  toApi() never emits streamKeyEnc / the key (POST/GET/PATCH/list)
 *   2  custom ingest URL is rtmp(s)-only + SSRF-checked; named presets resolve
 *      server-side and ignore client ingestUrl
 *   4  a streamKey beginning with `encv1:` is rejected (never stored plaintext)
 *   5  non-rtmp(s) schemes on custom → 400
 *   6  streamKey validation; `streamKey: ""` clears; omitting it leaves the
 *      stored ciphertext untouched
 *   7  rtmp present on non-rtmp / absent on rtmp / `url` on rtmp → 400
 *  10  key/platform mutation while assigned to an active production → 409
 *
 * CouchDB, Strom, and the WS controller are mocked. A deterministic 32-byte
 * RTMP_CREDENTIALS_KEY is injected so encryption at rest is exercised.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OutputDoc } from '../db/types.js';

const mockOutputsGet = vi.fn();
const mockOutputsInsert = vi.fn();
const mockOutputsFind = vi.fn();
const mockOutputsDestroy = vi.fn();
const mockDbFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: mockDbFind }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: mockOutputsGet, insert: mockOutputsInsert, find: mockOutputsFind, destroy: mockOutputsDestroy }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn() };
    flows = { get: vi.fn(), start: vi.fn().mockResolvedValue({}), stop: vi.fn().mockResolvedValue({}), delete: vi.fn().mockResolvedValue({}) };
    mixer = { multiviewEndpoint: vi.fn() };
    portLeases = { acquire: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const STREAM_KEY = 'abcd-1234-efgh-5678';
const originalEnv = { ...process.env };

let app: FastifyInstance;
let resetKeyCache: typeof import('../lib/srt-passphrase-crypto.js').resetKeyCache;
let encryptStreamKey: typeof import('../lib/rtmp-credentials-crypto.js').encryptStreamKey;

beforeAll(async () => {
  process.env['RTMP_CREDENTIALS_KEY'] = KEY_B64;
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
  ({ resetKeyCache } = await import('../lib/srt-passphrase-crypto.js'));
  ({ encryptStreamKey } = await import('../lib/rtmp-credentials-crypto.js'));
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

afterAll(() => {
  process.env = { ...originalEnv };
});

beforeEach(() => {
  process.env['RTMP_CREDENTIALS_KEY'] = KEY_B64;
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  resetKeyCache();
  mockOutputsGet.mockReset();
  mockOutputsInsert.mockReset();
  mockOutputsInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockOutputsFind.mockReset();
  mockOutputsDestroy.mockReset();
  mockDbFind.mockReset();
  mockDbFind.mockResolvedValue({ docs: [] }); // no active productions by default
});

/** Fails if any part of the JSON contains the stored ciphertext field or the key. */
function assertNoKeyLeak(body: unknown) {
  const s = JSON.stringify(body);
  expect(s).not.toContain('streamKeyEnc');
  expect(s).not.toContain(STREAM_KEY);
  expect(s).not.toContain('encv1:');
}

describe('POST /api/v1/outputs — create an RTMP destination', () => {
  it('resolves the youtube preset ingestUrl, encrypts the key at rest, and never echoes it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'YT main', outputType: 'rtmp', rtmp: { platform: 'youtube', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rtmp).toEqual({ platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeySet: true });
    assertNoKeyLeak(body);

    // Persisted doc: ciphertext only, never the plaintext key.
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.rtmp!.streamKeyEnc!.startsWith('encv1:')).toBe(true);
    expect(persisted.rtmp!.streamKeyEnc).not.toContain(STREAM_KEY);
    expect(persisted.rtmp!.ingestUrl).toBe('rtmps://a.rtmp.youtube.com/live2');
    // url is never populated for an rtmp output (no key-in-URL surface).
    expect(persisted.url).toBeUndefined();
  });

  it('accepts a custom rtmps:// ingest URL supplied by the operator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'Custom', outputType: 'rtmp', rtmp: { platform: 'custom', ingestUrl: 'rtmps://ingest.example.com/app', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rtmp.ingestUrl).toBe('rtmps://ingest.example.com/app');
    assertNoKeyLeak(res.json());
  });

  it('ignores a client ingestUrl on a named preset (cannot repoint)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'YT', outputType: 'rtmp', rtmp: { platform: 'youtube', ingestUrl: 'rtmp://attacker.example.com/x', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rtmp.ingestUrl).toBe('rtmps://a.rtmp.youtube.com/live2');
  });

  it('rejects a custom URL with a non-rtmp(s) scheme (condition 5)', async () => {
    for (const bad of ['http://evil.example.com/x', 'file:///etc/passwd', 'srt://host:9000', 'javascript:alert(1)']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/outputs',
        payload: { name: 'bad', outputType: 'rtmp', rtmp: { platform: 'custom', ingestUrl: bad, streamKey: STREAM_KEY } },
      });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('rejects a custom URL targeting a private/internal host (SSRF)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'ssrf', outputType: 'rtmp', rtmp: { platform: 'custom', ingestUrl: 'rtmp://169.254.169.254/app', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty / missing streamKey on create (condition 6)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'nokey', outputType: 'rtmp', rtmp: { platform: 'youtube' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a streamKey beginning with the reserved encv1: prefix (condition 4)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'enc', outputType: 'rtmp', rtmp: { platform: 'youtube', streamKey: 'encv1:AAAABBBB' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown platform (condition 7)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'x', outputType: 'rtmp', rtmp: { platform: 'kick', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects rtmp absent on an rtmp output (condition 7)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'x', outputType: 'rtmp' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects rtmp present on a non-rtmp output (condition 7)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'x', outputType: 'whep', rtmp: { platform: 'youtube', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a url (SRT-only field) on an rtmp output (condition 7)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'x', outputType: 'rtmp', url: 'srt://:9000', rtmp: { platform: 'youtube', streamKey: STREAM_KEY } },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET — RTMP responses never carry the key (condition 1)', () => {
  function storedYouTube(): OutputDoc {
    return {
      _id: 'output-yt', _rev: '1-a', type: 'output', name: 'YT', outputType: 'rtmp',
      rtmp: { platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeyEnc: encryptStreamKey(STREAM_KEY) },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('GET /api/v1/outputs/:id projects rtmp to platform/ingestUrl/streamKeySet only', async () => {
    mockOutputsGet.mockResolvedValue(storedYouTube());
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs/output-yt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().rtmp).toEqual({ platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeySet: true });
    assertNoKeyLeak(res.json());
  });

  it('GET /api/v1/outputs (list) never leaks the key', async () => {
    mockOutputsFind.mockResolvedValue({ docs: [storedYouTube()] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/outputs' });
    expect(res.statusCode).toBe(200);
    assertNoKeyLeak(res.json());
  });
});

describe('PATCH — key rotation, clearing, and untouched-on-omit (conditions 1/6)', () => {
  function existing(): OutputDoc {
    return {
      _id: 'output-yt', _rev: '1-a', type: 'output', name: 'YT', outputType: 'rtmp',
      rtmp: { platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeyEnc: encryptStreamKey('old-key-value') },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('re-encrypts a new streamKey and never echoes it', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { rtmp: { streamKey: STREAM_KEY } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rtmp.streamKeySet).toBe(true);
    assertNoKeyLeak(res.json());
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.rtmp!.streamKeyEnc!.startsWith('encv1:')).toBe(true);
    expect(persisted.rtmp!.streamKeyEnc).not.toContain(STREAM_KEY);
    expect(persisted.rtmp!.streamKeyEnc).not.toContain('old-key-value');
  });

  it('clears the key on an explicit streamKey: "" (streamKeySet=false, no stored ciphertext)', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { rtmp: { streamKey: '' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rtmp.streamKeySet).toBe(false);
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.rtmp!.streamKeyEnc).toBeUndefined();
  });

  it('leaves the stored ciphertext untouched when streamKey is omitted (rename only)', async () => {
    const doc = existing();
    mockOutputsGet.mockResolvedValue(doc);
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    const persisted = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(persisted.rtmp!.streamKeyEnc).toBe(doc.rtmp!.streamKeyEnc);
    expect(persisted.name).toBe('Renamed');
  });

  it('re-resolves ingestUrl when the platform changes', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { rtmp: { platform: 'twitch' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rtmp.ingestUrl).toBe('rtmp://live.twitch.tv/app');
  });

  it('rejects a url on an rtmp output patch (condition 7)', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { url: 'srt://:9000' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH — 409 when mutating key/platform on an active production (condition 10)', () => {
  function existing(): OutputDoc {
    return {
      _id: 'output-yt', _rev: '1-a', type: 'output', name: 'YT', outputType: 'rtmp',
      rtmp: { platform: 'youtube', ingestUrl: 'rtmps://a.rtmp.youtube.com/live2', streamKeyEnc: encryptStreamKey('old-key-value') },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
  }

  it('blocks a key rotation while the destination is assigned to an active production', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    mockDbFind.mockResolvedValue({ docs: [{ _id: 'prod-1', status: 'active', outputAssignments: [{ outputId: 'output-yt' }] }] });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { rtmp: { streamKey: STREAM_KEY } } });
    expect(res.statusCode).toBe(409);
  });

  it('allows a rename (non-credential mutation) even while active', async () => {
    mockOutputsGet.mockResolvedValue(existing());
    mockDbFind.mockResolvedValue({ docs: [{ _id: 'prod-1', status: 'active', outputAssignments: [{ outputId: 'output-yt' }] }] });
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-yt', payload: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
  });
});
