/**
 * Tests for `GET /api/v1/storage-connections/:id/capacity` (issue #613,
 * `docs/specs/storage-connections.md` §2.8a). CouchDB and the object store
 * (fetch) are mocked — no live services.
 *
 * Covers: single-disk FS storageinfo; erasure scaling; bucket-quota scope (and
 * its fall-backs to server scope); 403 → forbidden; 501 → not-supported;
 * network error → unreachable; AWS endpoint → not-supported; unknown id → 404;
 * the 30 s per-connection cache; and the SigV4 `Authorization` header for the
 * admin path against known vectors.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorageConnectionDoc } from '../db/types.js';

const TEST_BEARER = 'test-secret-key';
process.env['API_KEY'] = TEST_BEARER;

const store = new Map<string, StorageConnectionDoc>();

const storageDb = {
  get: vi.fn(async (id: string) => {
    const doc = store.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: StorageConnectionDoc) => {
    store.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true, id: doc._id, rev: '1-x' };
  }),
  destroy: vi.fn(),
  find: vi.fn(async () => ({ docs: Array.from(store.values()) })),
};

vi.mock('../db/index.js', () => ({
  getStorageConnectionsDb: () => storageDb,
  getSourcesDb: () => ({ findTrusted: vi.fn(async () => ({ docs: [] })), find: vi.fn(), get: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ find: vi.fn(async () => ({ docs: [] })), get: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getRecordingsDb: () => ({ find: vi.fn(async () => ({ docs: [] })), get: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getDb: () => ({ get: vi.fn(), find: vi.fn(), findTrusted: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {}, clearAudioState: vi.fn(), clearPipState: vi.fn(), clearFxState: vi.fn(),
}));

const AUTH = { authorization: `Bearer ${TEST_BEARER}` };
const GiB = 1024 ** 3;
const SECRET = 'super-secret-minio-key';

let app: FastifyInstance;
let lib: typeof import('../lib/storage-connection.js');

type Reply = { status: number; body: string } | Error;
type Route = 'storageinfo' | 'quota' | 'list';

/** Stubs fetch, routing by URL to the storageinfo / get-bucket-quota / ListObjectsV2 replies. */
function mockStore(replies: Partial<Record<Route, Reply>>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const route: Route = url.includes('/minio/admin/v3/storageinfo')
      ? 'storageinfo'
      : url.includes('/minio/admin/v3/get-bucket-quota')
        ? 'quota'
        : 'list';
    const reply = replies[route] ?? { status: 404, body: '' };
    if (reply instanceof Error) throw reply;
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: async () => reply.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function seed(id: string, extra: Partial<StorageConnectionDoc> = {}): string {
  store.set(id, {
    _id: id, _rev: '1-x', type: 'storage-connection', name: 'yle', endpoint: 'minio.example.com',
    // Dev no-op encryption (no STORAGE_CONNECTION_KEY): the plaintext secret passes through.
    useSsl: true, region: 'us-east-1', accessKey: 'AKCAP', secretKeyEnc: SECRET, role: 'recording',
    createdAt: 'x', updatedAt: 'x', ...extra,
  });
  return id;
}

function getCapacity(id: string) {
  return app.inject({ method: 'GET', url: `/api/v1/storage-connections/${id}/capacity`, headers: AUTH });
}

const FS_INFO = JSON.stringify({
  Disks: [{ endpoint: '/data', totalspace: 1000 * GiB, usedspace: 400 * GiB, availspace: 600 * GiB }],
  Backend: { Type: 1 },
});

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
  lib = await import('../lib/storage-connection.js');
});

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
  lib.clearStorageCapacityCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/v1/storage-connections/:id/capacity', () => {
  it('reports server capacity from a single-disk FS storageinfo response', async () => {
    const id = seed('stconn-fs');
    const fetchMock = mockStore({ storageinfo: { status: 200, body: FS_INFO } });
    const res = await getCapacity(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: 'available',
      totalBytes: 1000 * GiB,
      freeBytes: 600 * GiB,
      scope: 'server',
      referenceBitrateKbps: 10000,
    });
    // floor(600 GiB * 8 / 10 Mbit/s / 60)
    expect(body.estimatedMinutes).toBe(Math.floor((600 * GiB * 8) / (10000 * 1000) / 60));
    expect(new Date(body.checkedAt).toISOString()).toBe(body.checkedAt);
    // No defaultBucket → no quota call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://minio.example.com/minio/admin/v3/storageinfo');
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('scales an erasure backend by data / (data + parity)', async () => {
    const id = seed('stconn-ec');
    const disk = { totalspace: 100 * GiB, availspace: 80 * GiB };
    mockStore({
      storageinfo: {
        status: 200,
        body: JSON.stringify({
          Disks: [disk, disk, disk, disk],
          Backend: { Type: 2, StandardSCData: [2], StandardSCParities: [2] },
        }),
      },
    });
    const body = (await getCapacity(id)).json();
    expect(body.status).toBe('available');
    expect(body.totalBytes).toBe(200 * GiB); // 400 GiB raw * 2/4
    expect(body.freeBytes).toBe(160 * GiB); // 320 GiB raw * 2/4
    expect(body.scope).toBe('server');
  });

  it('uses bucket-quota scope when the default bucket has a hard quota', async () => {
    const id = seed('stconn-quota', { defaultBucket: 'recordings' });
    const fetchMock = mockStore({
      storageinfo: { status: 200, body: FS_INFO },
      quota: { status: 200, body: JSON.stringify({ quota: 0, size: 100 * GiB, quotatype: 'hard' }) },
      list: {
        status: 200,
        body: `<ListBucketResult><IsTruncated>false</IsTruncated>
          <Contents><Key>a.mp4</Key><Size>${30 * GiB}</Size></Contents>
          <Contents><Key>b/c.mp4</Key><Size>${10 * GiB}</Size></Contents></ListBucketResult>`,
      },
    });
    const body = (await getCapacity(id)).json();
    expect(body).toMatchObject({ status: 'available', scope: 'bucket-quota', totalBytes: 100 * GiB, freeBytes: 60 * GiB });
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://minio.example.com/minio/admin/v3/get-bucket-quota?bucket=recordings');
    // Recursive (no delimiter) walk capped at STORAGE_LIST_MAX_KEYS (default 1000).
    expect(urls).toContain('https://minio.example.com/recordings?list-type=2&max-keys=1000');
  });

  it('caps bucket-quota free space at the server free space', async () => {
    const id = seed('stconn-quota-cap', { defaultBucket: 'recordings' });
    mockStore({
      storageinfo: { status: 200, body: FS_INFO }, // 600 GiB free
      quota: { status: 200, body: JSON.stringify({ size: 5000 * GiB }) },
      list: { status: 200, body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' },
    });
    const body = (await getCapacity(id)).json();
    expect(body).toMatchObject({ scope: 'bucket-quota', totalBytes: 5000 * GiB, freeBytes: 600 * GiB });
  });

  it('falls back to server scope when the usage walk is truncated or the quota call fails', async () => {
    const id = seed('stconn-trunc', { defaultBucket: 'recordings' });
    mockStore({
      storageinfo: { status: 200, body: FS_INFO },
      quota: { status: 200, body: JSON.stringify({ size: 100 * GiB }) },
      list: { status: 200, body: '<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>' },
    });
    expect((await getCapacity(id)).json()).toMatchObject({ scope: 'server', totalBytes: 1000 * GiB });

    lib.clearStorageCapacityCache();
    mockStore({ storageinfo: { status: 200, body: FS_INFO }, quota: { status: 403, body: '' } });
    expect((await getCapacity(id)).json()).toMatchObject({ status: 'available', scope: 'server' });

    lib.clearStorageCapacityCache();
    mockStore({ storageinfo: { status: 200, body: FS_INFO }, quota: new TypeError('fetch failed') });
    expect((await getCapacity(id)).json()).toMatchObject({ status: 'available', scope: 'server' });
  });

  it('maps 403 to forbidden (key lacks admin:StorageInfo)', async () => {
    const id = seed('stconn-403');
    mockStore({ storageinfo: { status: 403, body: '{"Code":"AccessDenied","Message":"Access Denied."}' } });
    const res = await getCapacity(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ status: 'unavailable', reason: 'forbidden', checkedAt: body.checkedAt });
  });

  it('maps 501 (and 400/404/405) to not-supported', async () => {
    const id = seed('stconn-501');
    for (const status of [501, 400, 404, 405]) {
      lib.clearStorageCapacityCache();
      mockStore({ storageinfo: { status, body: 'Not Implemented' } });
      const res = await getCapacity(id);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'unavailable', reason: 'not-supported' });
    }
  });

  it('maps a 200 that is not a madmin StorageInfo to not-supported', async () => {
    const id = seed('stconn-notminio');
    mockStore({ storageinfo: { status: 200, body: '<html>hello</html>' } });
    expect((await getCapacity(id)).json()).toMatchObject({ status: 'unavailable', reason: 'not-supported' });
  });

  it('reports not-supported for an AWS S3 endpoint without calling it', async () => {
    const id = seed('stconn-aws', { endpoint: 's3.eu-west-1.amazonaws.com' });
    const fetchMock = mockStore({});
    expect((await getCapacity(id)).json()).toMatchObject({ status: 'unavailable', reason: 'not-supported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a network error to unreachable (never 5xx)', async () => {
    const id = seed('stconn-net');
    mockStore({ storageinfo: new TypeError('fetch failed') });
    const res = await getCapacity(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unavailable', reason: 'unreachable' });
  });

  it('passes a 5 s abort signal to the upstream request', async () => {
    const id = seed('stconn-timeout');
    const fetchMock = mockStore({ storageinfo: { status: 200, body: FS_INFO } });
    await getCapacity(id);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(lib.CAPACITY_TIMEOUT_MS).toBe(5000);
  });

  it('404s an unknown connection id', async () => {
    const fetchMock = mockStore({});
    const res = await getCapacity('stconn-nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Storage connection not found', statusCode: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches the result per connection for 30 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    const id = seed('stconn-cache');
    const fetchMock = mockStore({ storageinfo: { status: 200, body: FS_INFO } });

    const first = (await getCapacity(id)).json();
    vi.setSystemTime(new Date('2026-11-02T10:00:29Z'));
    const second = (await getCapacity(id)).json();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    vi.setSystemTime(new Date('2026-11-02T10:00:31Z'));
    const third = (await getCapacity(id)).json();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(third.checkedAt).toBe('2026-11-02T10:00:31.000Z');
  });
});

describe('SigV4 signing (generalised signer)', () => {
  // AWS-published S3 SigV4 example ("GET Bucket Lifecycle", header-based auth).
  it('matches the AWS S3 documentation vector', () => {
    const { headers } = lib.signS3GetRequest(
      {
        endpoint: 'examplebucket.s3.amazonaws.com', useSsl: true, region: 'us-east-1',
        accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      '/',
      { lifecycle: '' },
      new Date('2013-05-24T00:00:00Z'),
    );
    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  // Vectors for the MinIO admin paths, independently produced by
  // `curl --aws-sigv4 aws:amz:<region>:s3` (curl 7.88.1) with the same date.
  it('signs the admin storageinfo path as captured from the request (known vector)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-02T08:20:55Z'));
    const id = seed('stconn-vector', {
      endpoint: '127.0.0.1:18999', useSsl: false, region: 'eu-north-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKeyEnc: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const fetchMock = mockStore({ storageinfo: { status: 200, body: FS_INFO } });
    await getCapacity(id);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18999/minio/admin/v3/storageinfo');
    const headers = init!.headers as Record<string, string>;
    expect(headers['x-amz-date']).toBe('20261102T082055Z');
    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261102/eu-north-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=90f870dcdc167349a83686db9e23fa87d1c296be1a4327e84ddb0b18341de411',
    );
  });

  it('signs the admin get-bucket-quota path with its query (known vector)', () => {
    const { url, headers } = lib.signS3GetRequest(
      { endpoint: '127.0.0.1:18999', useSsl: false, region: 'us-east-1', accessKey: 'minioadmin', secretKey: 'minioadmin' },
      '/minio/admin/v3/get-bucket-quota',
      { bucket: 'recordings' },
      new Date('2026-11-02T08:20:47Z'),
    );
    expect(url).toBe('http://127.0.0.1:18999/minio/admin/v3/get-bucket-quota?bucket=recordings');
    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=minioadmin/20261102/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=4334728c46e9c4a6b6ca97d4cf463cb392e3b103c4c0e6c023cbb2a837378ce0',
    );
  });
});
