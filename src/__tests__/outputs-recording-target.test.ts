/**
 * A `recording` output needs a storage target (issue #534): the MINIO_* env
 * store, or a storage connection that exists. No `MINIO_*` env is set here, so
 * only a storage connection makes a recording output valid. CouchDB is mocked.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OutputDoc, StorageConnectionDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
delete process.env['MINIO_ENDPOINT'];
delete process.env['MINIO_ACCESS_KEY'];
delete process.env['MINIO_SECRET_KEY'];
delete process.env['MINIO_BUCKET'];

const outputs = new Map<string, OutputDoc>();
const connections = new Map<string, StorageConnectionDoc>();

const outputsDb = {
  get: vi.fn(async (id: string) => {
    const doc = outputs.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: OutputDoc) => {
    outputs.set(doc._id, doc);
    return { ok: true, id: doc._id, rev: '1-x' };
  }),
  find: vi.fn(async () => ({ docs: Array.from(outputs.values()) })),
  destroy: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getOutputsDb: () => outputsDb,
  getStorageConnectionsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = connections.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return doc;
    }),
  }),
  getDb: () => ({ get: vi.fn(), find: vi.fn(async () => ({ docs: [] })), findTrusted: vi.fn(async () => ({ docs: [] })) }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(async () => ({ docs: [] })), findTrusted: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
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

function connection(id: string, over: Partial<StorageConnectionDoc> = {}): StorageConnectionDoc {
  return {
    _id: id, type: 'storage-connection', name: id, endpoint: 's3.example.com', useSsl: true,
    region: 'eu-west-1', accessKey: 'AK', secretKeyEnc: 'encv1:zzz', defaultBucket: 'vod',
    role: 'recording', createdAt: 'x', updatedAt: 'x', ...over,
  };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  outputs.clear();
  connections.clear();
  outputsDb.insert.mockClear();
});

describe('POST /api/v1/outputs (recording)', () => {
  it('creates a recording output on a storage connection when MINIO_* is not set', async () => {
    connections.set('stconn-C', connection('stconn-C'));
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs', headers: AUTH,
      payload: { name: 'VOD', outputType: 'recording', connectionId: 'stconn-C' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().connectionId).toBe('stconn-C');
    expect(res.json().outputType).toBe('recording');
  });

  it('400s without a connectionId, naming both MINIO_* and storage connections', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs', headers: AUTH,
      payload: { name: 'VOD', outputType: 'recording' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('MINIO_*');
    expect(res.json().error).toContain('storage connection');
    expect(outputsDb.insert).not.toHaveBeenCalled();
  });

  it('400s with the reserved "default" connection when MINIO_* is not set', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs', headers: AUTH,
      payload: { name: 'VOD', outputType: 'recording', connectionId: 'default' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('MINIO_*');
  });

  it('400s "Storage connection not found" for an unknown connectionId and writes nothing', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs', headers: AUTH,
      payload: { name: 'VOD', outputType: 'recording', connectionId: 'stconn-nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Storage connection not found');
    expect(outputsDb.insert).not.toHaveBeenCalled();
  });

  it('400s for a connection with no default bucket', async () => {
    connections.set('stconn-nobucket', connection('stconn-nobucket', { defaultBucket: undefined }));
    const res = await app.inject({
      method: 'POST', url: '/api/v1/outputs', headers: AUTH,
      payload: { name: 'VOD', outputType: 'recording', connectionId: 'stconn-nobucket' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Storage connection has no default bucket');
  });
});

describe('PATCH /api/v1/outputs/:id (recording connectionId)', () => {
  beforeEach(() => {
    outputs.set('output-rec', {
      _id: 'output-rec', type: 'output', name: 'VOD', outputType: 'recording',
      connectionId: 'stconn-C', createdAt: 'x', updatedAt: 'x',
    });
    connections.set('stconn-C', connection('stconn-C'));
    connections.set('stconn-D', connection('stconn-D'));
  });

  it('re-points the output at another existing connection', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/outputs/output-rec', headers: AUTH, payload: { connectionId: 'stconn-D' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().connectionId).toBe('stconn-D');
  });

  it('400s "Storage connection not found" for an unknown connectionId and writes nothing', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/outputs/output-rec', headers: AUTH, payload: { connectionId: 'stconn-nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Storage connection not found');
    expect(outputsDb.insert).not.toHaveBeenCalled();
    expect(outputs.get('output-rec')!.connectionId).toBe('stconn-C');
  });

  it('still allows a rename without touching the connection', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/outputs/output-rec', headers: AUTH, payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Renamed');
  });
});
