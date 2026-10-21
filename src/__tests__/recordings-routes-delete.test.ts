/**
 * Route tests for DELETE /api/v1/recordings/:id (issue #550).
 *
 * Covers the acceptance criteria with CouchDB and the S3 DeleteObject request
 * mocked (global `fetch` is stubbed; the SigV4 signer runs for real):
 *   - 204 on a storage-connection recording and on a `MINIO_*` default one;
 *     the signed DELETE goes to the right endpoint/bucket/key and the doc is
 *     destroyed (criteria 1, 2).
 *   - 204 when the object was already removed (404 NoSuchKey) (criterion 3).
 *   - 502 storage-denied on a 403, doc kept (criterion 4).
 *   - 502 storage-failed on other store errors, no S3 body echoed.
 *   - 409 connection-missing / bucket-mismatch / storage-not-configured
 *     style refusals, doc kept, no S3 call (criterion 5).
 *   - 404 on an unknown id (criterion 6).
 *   - 503 when the doc delete fails after the object delete; retry succeeds.
 *   - Other recordings are untouched (criterion 8); info log on success.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordingDoc, StorageConnectionDoc } from '../db/types.js';

const TEST_BEARER = 'test-secret-key';
process.env['API_KEY'] = TEST_BEARER;
process.env['MINIO_ENDPOINT'] = 'https://minio.example.com';
process.env['MINIO_ACCESS_KEY'] = 'AKIAEXAMPLE';
process.env['MINIO_SECRET_KEY'] = 'secretexamplekey';
process.env['MINIO_BUCKET'] = 'openlive-vod';
process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 9).toString('base64');

const recordings = new Map<string, RecordingDoc>();
const connections = new Map<string, StorageConnectionDoc>();
let destroyFails = false;

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}

const recordingsDb = {
  get: vi.fn(async (id: string) => {
    const doc = recordings.get(id);
    if (!doc) throw notFound();
    return doc;
  }),
  find: vi.fn(async () => ({ docs: Array.from(recordings.values()) })),
  insert: vi.fn(),
  destroy: vi.fn(async (id: string, rev: string) => {
    if (destroyFails) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const doc = recordings.get(id);
    if (!doc || doc._rev !== rev) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    recordings.delete(id);
    return { ok: true, id, rev };
  }),
};

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn() }),
  getRecordingsDb: () => recordingsDb,
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
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

const AUTH = { authorization: `Bearer ${TEST_BEARER}` };
let app: FastifyInstance;

/** Stubbed S3: answers each DeleteObject with the next queued response. */
const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
function s3Responds(status: number, body = ''): void {
  fetchMock.mockImplementationOnce(async () => new Response(status === 204 ? null : body, { status }));
}

function recording(over: Partial<RecordingDoc> = {}): RecordingDoc {
  const now = '2026-10-20T10:00:00.000Z';
  const doc: RecordingDoc = {
    _id: `recording-${Math.random().toString(16).slice(2)}`,
    _rev: '1-a',
    type: 'recording',
    productionId: 'prod-1',
    connectionId: 'stconn-C',
    bucket: 'tenant-vod',
    key: 'prod-1/prod-1_20261020_100000_00000.mp4',
    sizeBytes: 1234,
    startedAt: now,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  recordings.set(doc._id, doc);
  return doc;
}

function del(id: string) {
  return app.inject({ method: 'DELETE', url: `/api/v1/recordings/${id}`, headers: AUTH });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
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
  destroyFails = false;
  fetchMock.mockReset();
  recordingsDb.destroy.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env['STORAGE_CONNECTION_KEY'];
});

describe('DELETE /api/v1/recordings/:id (issue #550)', () => {
  it('deletes a storage-connection recording: object first, then the entry (204)', async () => {
    const rec = recording();
    const other = recording({ productionId: 'prod-2', key: 'prod-2/other.mp4' });
    s3Responds(204);

    const res = await del(rec._id);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('DELETE');
    expect(url).toBe('https://s3.tenant.example.com/tenant-vod/prod-1/prod-1_20261020_100000_00000.mp4');
    expect((init.headers as Record<string, string>)['Authorization']).toContain('Credential=AKTENANT/');
    expect(recordingsDb.destroy).toHaveBeenCalledWith(rec._id, '1-a');

    // Gone from GET by id and from the list; the other recording is untouched.
    expect((await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec._id}`, headers: AUTH })).statusCode).toBe(404);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: AUTH })).json();
    expect(list.map((r: { id: string }) => r.id)).toEqual([other._id]);
  });

  it('deletes a recording stored in the MINIO_* default (204)', async () => {
    const rec = recording({ connectionId: undefined, bucket: 'openlive-vod', key: 'prod-1/segment_00001.mp4' });
    s3Responds(204);
    const res = await del(rec._id);
    expect(res.statusCode).toBe(204);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://minio.example.com/openlive-vod/prod-1/segment_00001.mp4');
    expect((init.headers as Record<string, string>)['Authorization']).toContain('Credential=AKIAEXAMPLE/');
    expect(recordings.has(rec._id)).toBe(false);
  });

  it('returns 204 and removes the entry when the object is already gone (404 NoSuchKey)', async () => {
    const rec = recording();
    s3Responds(404, '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
    const res = await del(rec._id);
    expect(res.statusCode).toBe(204);
    expect(recordings.has(rec._id)).toBe(false);
  });

  it('returns 502 storage-denied and keeps the entry when the key may not delete (403)', async () => {
    const rec = recording();
    s3Responds(403, '<Error><Code>AccessDenied</Code><Message>Access Denied.</Message><Resource>/tenant-vod/x</Resource></Error>');
    const res = await del(rec._id);
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toBe('storage-denied');
    expect(res.body).not.toContain('AccessDenied');
    expect(res.body).not.toContain('tenant-vod');
    expect(recordingsDb.destroy).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec._id}`, headers: AUTH })).statusCode).toBe(200);
  });

  it('returns 502 storage-failed on another store error without echoing the S3 body', async () => {
    const rec = recording();
    s3Responds(500, '<Error><Code>InternalError</Code><Message>secret-ish detail</Message></Error>');
    const res = await del(rec._id);
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toBe('storage-failed');
    expect(res.body).not.toContain('secret-ish');
    expect(recordings.has(rec._id)).toBe(true);
  });

  it('returns 502 storage-failed when the bucket does not exist (404 NoSuchBucket)', async () => {
    const rec = recording();
    s3Responds(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const res = await del(rec._id);
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toBe('storage-failed');
    expect(recordings.has(rec._id)).toBe(true);
  });

  it('returns 502 storage-failed when the store is unreachable', async () => {
    const rec = recording();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await del(rec._id);
    expect(res.statusCode).toBe(502);
    expect(res.json().reason).toBe('storage-failed');
    expect(recordings.has(rec._id)).toBe(true);
  });

  it('returns 409 connection-missing and keeps the entry when the connection was removed', async () => {
    const rec = recording({ connectionId: 'stconn-gone' });
    const res = await del(rec._id);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('connection-missing');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordings.has(rec._id)).toBe(true);
  });

  it('returns 409 bucket-mismatch for a default recording in another bucket', async () => {
    const rec = recording({ connectionId: undefined, bucket: 'old-bucket' });
    const res = await del(rec._id);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('bucket-mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordings.has(rec._id)).toBe(true);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await del('recording-missing');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Recording not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 503 when the entry delete fails after the object delete; a retry succeeds', async () => {
    const rec = recording();
    destroyFails = true;
    s3Responds(204);
    const first = await del(rec._id);
    expect(first.statusCode).toBe(503);
    expect(recordings.has(rec._id)).toBe(true);

    destroyFails = false;
    s3Responds(404, '<Error><Code>NoSuchKey</Code></Error>');
    const retry = await del(rec._id);
    expect(retry.statusCode).toBe(204);
    expect(recordings.has(rec._id)).toBe(false);
  });

  it('logs id, bucket and key at info level on success', async () => {
    const rec = recording();
    s3Responds(204);
    const info = vi.spyOn(app.log, 'info');
    try {
      expect((await del(rec._id)).statusCode).toBe(204);
      expect(info).toHaveBeenCalledWith(
        { id: rec._id, bucket: 'tenant-vod', key: rec.key },
        'recording deleted',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('requires the API key', async () => {
    const rec = recording();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/recordings/${rec._id}` });
    expect(res.statusCode).toBe(401);
    expect(recordings.has(rec._id)).toBe(true);
  });
});
