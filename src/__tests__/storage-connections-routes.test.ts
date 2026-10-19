/**
 * Route tests for the storage-connections REST surface (issue #520, OL-21,
 * `docs/specs/storage-connections.md`, ADR-009). CouchDB and the object store
 * (fetch) are mocked — no live services.
 *
 * Covers: create (secret write-only, never returned/stored plaintext), SSRF
 * rejection, the synthetic default connection + default-connection fallback on
 * the listing endpoint, delete-while-referenced (409 across sources/outputs/
 * recordings), the test probe classification, and the object listing.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StorageConnectionDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
// Active encryption so secretKeyEnc is real ciphertext (not the dev plaintext no-op).
process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 3).toString('base64');
// A configured env default so the synthetic "default" connection materialises.
process.env['MINIO_ENDPOINT'] = 'https://minio.example.com';
process.env['MINIO_ACCESS_KEY'] = 'AKIADEFAULT';
process.env['MINIO_SECRET_KEY'] = 'defaultsecret';
process.env['MINIO_BUCKET'] = 'default-bucket';

const store = new Map<string, StorageConnectionDoc>();
const sourcesDocs: Array<Pick<SourceDoc, 'address'>> = [];
const outputsDocs: Array<Record<string, unknown>> = [];
const recordingsDocs: Array<Record<string, unknown>> = [];

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
  destroy: vi.fn(async (id: string) => {
    store.delete(id);
    return { ok: true };
  }),
  find: vi.fn(async () => ({ docs: Array.from(store.values()) })),
};

const sourcesDb = {
  findTrusted: vi.fn(async () => ({ docs: sourcesDocs })),
  find: vi.fn(), get: vi.fn(), insert: vi.fn(), destroy: vi.fn(),
};
const outputsDb = {
  find: vi.fn(async () => ({ docs: outputsDocs })),
  get: vi.fn(), insert: vi.fn(), destroy: vi.fn(),
};
const recordingsDb = {
  find: vi.fn(async () => ({ docs: recordingsDocs })),
  get: vi.fn(), insert: vi.fn(), destroy: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getStorageConnectionsDb: () => storageDb,
  getSourcesDb: () => sourcesDb,
  getOutputsDb: () => outputsDb,
  getRecordingsDb: () => recordingsDb,
  getDb: () => ({ get: vi.fn(), find: vi.fn(), findTrusted: vi.fn() }),
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

function mockFetch(status: number, body: string) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status >= 200 && status < 300, text: async () => body })));
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  store.clear();
  sourcesDocs.length = 0;
  outputsDocs.length = 0;
  recordingsDocs.length = 0;
  vi.unstubAllGlobals();
});

const validCreate = {
  name: 'Customer West S3',
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  defaultBucket: 'acme-clips',
  role: 'clip',
};

describe('POST /api/v1/storage-connections', () => {
  it('creates a connection, never returns the secret, and stores only ciphertext', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^stconn-/);
    expect(body.endpoint).toBe('s3.eu-west-1.amazonaws.com'); // scheme stripped
    expect(body.useSsl).toBe(true);
    expect(body.accessKey).toBe('AKIAEXAMPLE'); // access key id is not a secret
    expect(body.secretKeySet).toBe(true);
    expect(body.secretKey).toBeUndefined();
    expect(body.secretKeyEnc).toBeUndefined();

    const stored = store.get(body.id)!;
    expect(stored.secretKeyEnc.startsWith('encv1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(validCreate.secretKey);
  });

  it('rejects a private/loopback endpoint with 400 (SSRF) unless allow-listed', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/storage-connections', headers: AUTH,
      payload: { ...validCreate, endpoint: 'http://192.168.1.50:9000' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/TRUSTED_STORAGE_HOSTS/);
  });

  it('401s without the API key', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage-connections', payload: validCreate });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/storage-connections', () => {
  it('lists connections and includes the synthetic default (no secret)', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate });
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage-connections', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    const def = list.find((c: { id: string }) => c.id === 'default');
    expect(def).toBeTruthy();
    expect(def.isDefault).toBe(true);
    expect(def.endpoint).toBe('minio.example.com');
    expect(def.secretKeySet).toBe(true);
    expect(JSON.stringify(list)).not.toContain('defaultsecret');
  });
});

describe('PATCH /api/v1/storage-connections/:id', () => {
  it('keeps the stored secret when secretKey is omitted, re-encrypts when provided', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate })).json();
    const encBefore = store.get(created.id)!.secretKeyEnc;

    const patch1 = await app.inject({ method: 'PATCH', url: `/api/v1/storage-connections/${created.id}`, headers: AUTH, payload: { name: 'Renamed' } });
    expect(patch1.statusCode).toBe(200);
    expect(patch1.json().name).toBe('Renamed');
    expect(store.get(created.id)!.secretKeyEnc).toBe(encBefore); // unchanged

    const patch2 = await app.inject({ method: 'PATCH', url: `/api/v1/storage-connections/${created.id}`, headers: AUTH, payload: { secretKey: 'new-secret-value' } });
    expect(patch2.statusCode).toBe(200);
    expect(store.get(created.id)!.secretKeyEnc).not.toBe(encBefore); // re-encrypted
    expect(patch2.json().secretKey).toBeUndefined();
  });

  it('403s a PATCH on the read-only default connection', async () => {
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/storage-connections/default', headers: AUTH, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/v1/storage-connections/:id (referential integrity)', () => {
  function seed(): string {
    const id = 'stconn-ref';
    store.set(id, {
      _id: id, _rev: '1-x', type: 'storage-connection', name: 'ref', endpoint: 's3.x.com',
      useSsl: true, region: 'us-east-1', accessKey: 'AK', secretKeyEnc: 'encv1:zzz', role: 'both',
      createdAt: 'x', updatedAt: 'x',
    });
    return id;
  }

  it('409s when referenced by a recording, with reference counts', async () => {
    const id = seed();
    recordingsDocs.push({ _id: 'rec-1', connectionId: id });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/storage-connections/${id}`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().references.recordings).toBe(1);
    expect(store.has(id)).toBe(true);
  });

  it('409s when referenced by a recording output (regression, issue #534)', async () => {
    const id = seed();
    outputsDocs.push({ _id: 'output-rec', outputType: 'recording', connectionId: id });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/storage-connections/${id}`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().references.outputs).toBe(1);
    expect(store.has(id)).toBe(true);
  });

  it('409s when referenced by an s3 clip source (connectionId inside the address JSON)', async () => {
    const id = seed();
    sourcesDocs.push({ address: JSON.stringify({ type: 's3', bucket: 'b', key: 'k', connectionId: id }) });
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/storage-connections/${id}`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().references.sources).toBe(1);
  });

  it('204s when no references remain', async () => {
    const id = seed();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/storage-connections/${id}`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    expect(store.has(id)).toBe(false);
  });

  it('403s a DELETE on the default connection', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/storage-connections/default', headers: AUTH });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /api/v1/storage-connections/:id/test', () => {
  function seed(): string {
    const id = 'stconn-test';
    store.set(id, {
      _id: id, _rev: '1-x', type: 'storage-connection', name: 't', endpoint: 's3.x.com',
      useSsl: true, region: 'us-east-1', accessKey: 'AK',
      secretKeyEnc: '', defaultBucket: 'the-bucket', role: 'clip', createdAt: 'x', updatedAt: 'x',
    });
    return id;
  }

  it('reports reachable + auth ok + bucket found on a 200', async () => {
    const id = seed();
    mockFetch(200, '<ListBucketResult></ListBucketResult>');
    const res = await app.inject({ method: 'POST', url: `/api/v1/storage-connections/${id}/test`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.checkedFrom).toBe('open-live');
    expect(body.reachable).toBe(true);
    expect(body.auth).toBe('ok');
    expect(body.bucket).toBe('found');
  });

  it('reports auth forbidden on AccessDenied, bucket not-found on 404', async () => {
    const id = seed();
    mockFetch(403, '<Error><Code>AccessDenied</Code></Error>');
    const denied = await app.inject({ method: 'POST', url: `/api/v1/storage-connections/${id}/test`, headers: AUTH, payload: {} });
    expect(denied.json().auth).toBe('forbidden');

    mockFetch(404, '<Error><Code>NoSuchBucket</Code></Error>');
    const missing = await app.inject({ method: 'POST', url: `/api/v1/storage-connections/${id}/test`, headers: AUTH, payload: {} });
    expect(missing.json().bucket).toBe('not-found');
  });

  it('echoes checkedFrom open-live with a note when from:strom is requested', async () => {
    const id = seed();
    mockFetch(200, '<ListBucketResult></ListBucketResult>');
    const res = await app.inject({ method: 'POST', url: `/api/v1/storage-connections/${id}/test`, headers: AUTH, payload: { from: 'strom' } });
    expect(res.json().checkedFrom).toBe('open-live');
    expect(res.json().note).toMatch(/Strom-side check unavailable/);
  });

  it('404s an unknown connection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage-connections/nope/test', headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/v1/storage-connections/:id/objects', () => {
  const LISTING = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>NEXT123</NextContinuationToken>
    <CommonPrefixes><Prefix>shows/2026/ep1/</Prefix></CommonPrefixes>
    <Contents><Key>shows/2026/intro.mp4</Key><Size>10485760</Size><LastModified>2026-10-01T12:00:00.000Z</LastModified></Contents>
  </ListBucketResult>`;

  it('returns folders + objects + cursor, never credentials', async () => {
    const id = 'stconn-obj';
    store.set(id, {
      _id: id, _rev: '1-x', type: 'storage-connection', name: 'o', endpoint: 's3.x.com',
      useSsl: true, region: 'us-east-1', accessKey: 'AK', secretKeyEnc: '', defaultBucket: 'acme-clips', role: 'clip', createdAt: 'x', updatedAt: 'x',
    });
    mockFetch(200, LISTING);
    const res = await app.inject({ method: 'GET', url: `/api/v1/storage-connections/${id}/objects?prefix=shows/2026/`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.folders).toEqual([{ prefix: 'shows/2026/ep1/' }]);
    expect(body.objects[0]).toMatchObject({ key: 'shows/2026/intro.mp4', name: 'intro.mp4', size: 10485760 });
    expect(body.cursor).toBe('NEXT123');
    expect(JSON.stringify(body)).not.toContain('AK');
  });

  it('403s when the key lacks list permission', async () => {
    const id = 'stconn-obj2';
    store.set(id, {
      _id: id, _rev: '1-x', type: 'storage-connection', name: 'o', endpoint: 's3.x.com',
      useSsl: true, region: 'us-east-1', accessKey: 'AK', secretKeyEnc: '', defaultBucket: 'acme-clips', role: 'clip', createdAt: 'x', updatedAt: 'x',
    });
    mockFetch(403, '<Error><Code>AccessDenied</Code></Error>');
    const res = await app.inject({ method: 'GET', url: `/api/v1/storage-connections/${id}/objects`, headers: AUTH });
    expect(res.statusCode).toBe(403);
  });

  it('lists against the default (env) connection — default-connection fallback', async () => {
    mockFetch(200, LISTING);
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage-connections/default/objects?bucket=default-bucket', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().objects).toHaveLength(1);
  });
});
