/**
 * Recordings routes on an instance with no `MINIO_*` env (issue #534): the
 * stored recordings are listed (not 503), a recording on a storage connection
 * gets `playbackUrl` + `downloadUrl`, and an unsignable one says why with
 * `playbackUnavailable`. A database failure still returns 503.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordingDoc, StorageConnectionDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
delete process.env['MINIO_ENDPOINT'];
delete process.env['MINIO_ACCESS_KEY'];
delete process.env['MINIO_SECRET_KEY'];
delete process.env['MINIO_BUCKET'];
process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 9).toString('base64');

const recordings = new Map<string, RecordingDoc>();
const connections = new Map<string, StorageConnectionDoc>();
let dbDown = false;

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      // Same CouchDB as the recordings DB: an outage fails this lookup first.
      if (dbDown) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (id !== 'prod-1') throw notFound();
      return { _id: 'prod-1' };
    }),
    insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn(),
  }),
  getRecordingsDb: () => ({
    get: vi.fn(async (id: string) => {
      if (dbDown) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const doc = recordings.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    find: vi.fn(async (query: { selector: { productionId?: string } }) => {
      if (dbDown) throw new Error('ECONNREFUSED');
      const all = Array.from(recordings.values());
      const pid = query.selector.productionId;
      return { docs: pid ? all.filter((r) => r.productionId === pid) : all };
    }),
    insert: vi.fn(),
  }),
  getStorageConnectionsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = connections.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
  }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {}, clearAudioState: vi.fn(), clearPipState: vi.fn(), clearFxState: vi.fn(),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
let app: FastifyInstance;

function recording(over: Partial<RecordingDoc> = {}): RecordingDoc {
  const now = '2026-10-19T10:00:00.000Z';
  return {
    _id: `recording-${Math.random().toString(16).slice(2)}`,
    type: 'recording',
    productionId: 'prod-1',
    connectionId: 'stconn-C',
    bucket: 'tenant-vod',
    key: 'prod-1/prod-1_20261019_100000_00000.mp4',
    sizeBytes: 1234,
    durationMs: 61000,
    startedAt: now,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  const { encryptStorageSecret } = await import('../lib/storage-connection-crypto.js');
  connections.set('stconn-C', {
    _id: 'stconn-C', type: 'storage-connection', name: 'Tenant', endpoint: 's3.tenant.example.com',
    useSsl: true, region: 'eu-west-1', accessKey: 'AKTENANT', secretKeyEnc: encryptStorageSecret('tenant-secret'),
    defaultBucket: 'tenant-vod', role: 'recording', createdAt: 'x', updatedAt: 'x',
  });
  app = await buildServer();
});

beforeEach(() => {
  recordings.clear();
  dbDown = false;
});

afterAll(() => {
  delete process.env['STORAGE_CONNECTION_KEY'];
});

describe('recordings routes without MINIO_* (connection-only instance)', () => {
  it('GET /api/v1/recordings returns [] (not 503) when there are none', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('lists a connection recording with playbackUrl and downloadUrl', async () => {
    const rec = recording();
    recordings.set(rec._id, rec);
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const [item] = res.json();
    expect(item.durationMs).toBe(61000);
    expect(item.playbackUrl).toContain('https://s3.tenant.example.com/tenant-vod/prod-1/prod-1_20261019_100000_00000.mp4?');
    expect(item.playbackUrl).not.toContain('response-content-disposition');
    expect(item.downloadUrl).toContain('/tenant-vod/prod-1/prod-1_20261019_100000_00000.mp4?');
    expect(item.downloadUrl).toContain(
      'response-content-disposition=attachment%3B%20filename%3D%22prod-1_20261019_100000_00000.mp4%22',
    );
    expect(item.downloadUrl).toContain('X-Amz-Expires=3600');
    expect(item.downloadUrl).toContain('X-Amz-Signature=');
    expect(item.playbackUnavailable).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('tenant-secret');
  });

  it('GET /api/v1/recordings/:id works and says connection-missing when the connection is gone', async () => {
    const rec = recording({ connectionId: 'stconn-deleted' });
    recordings.set(rec._id, rec);
    const res = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec._id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().playbackUrl).toBeUndefined();
    expect(res.json().downloadUrl).toBeUndefined();
    expect(res.json().playbackUnavailable).toBe('connection-missing');
  });

  it('says storage-not-configured for a default-connection recording', async () => {
    const rec = recording({ connectionId: undefined, bucket: 'openlive-vod' });
    recordings.set(rec._id, rec);
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].playbackUnavailable).toBe('storage-not-configured');
  });

  it('returns 503 on a database failure', async () => {
    dbDown = true;
    const list = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: AUTH });
    expect(list.statusCode).toBe(503);
    const perProd = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1/recordings', headers: AUTH });
    expect(perProd.statusCode).toBe(503);
    const one = await app.inject({ method: 'GET', url: '/api/v1/recordings/recording-x', headers: AUTH });
    expect(one.statusCode).toBe(503);
  });

  it('returns 404 for a missing production', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-missing/recordings', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Production not found');
  });

  it('returns 404 for a missing recording', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings/recording-missing', headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

describe('downloadFileName', () => {
  it('uses the key basename, keeps .mp4, and strips header-unsafe characters', async () => {
    const { downloadFileName } = await import('../routes/recordings.js');
    expect(downloadFileName('vod/prod-1/prod-1_20261019_100000_00000.mp4')).toBe('prod-1_20261019_100000_00000.mp4');
    expect(downloadFileName('a/b"c;d.mp4')).toBe('b_c_d.mp4');
    expect(downloadFileName('a/segment.mkv')).toBe('segment.mp4');
    expect(downloadFileName('a/noext')).toBe('noext.mp4');
  });
});
