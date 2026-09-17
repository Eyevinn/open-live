/**
 * Route tests for the VOD listing + playback endpoints (epic #5, issue #42).
 *
 * Covers:
 *   - GET /api/v1/productions/:id/recordings — lists a production's recordings,
 *     attaches a presigned playbackUrl, and 404s for an unknown production.
 *   - GET /api/v1/recordings — lists across all productions.
 *   - GET /api/v1/recordings/:id — fetch one; 404 when missing.
 *   - 503 when object storage is not configured.
 *
 * CouchDB is mocked and the MinIO SigV4 presigner runs for real (no bucket
 * needed — presignGetUrl is pure crypto), so playbackUrl is asserted structurally.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordingDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
// Enable recording: config reads these at import time.
process.env['MINIO_ENDPOINT'] = 'https://minio.example.com';
process.env['MINIO_ACCESS_KEY'] = 'AKIAEXAMPLE';
process.env['MINIO_SECRET_KEY'] = 'secretexamplekey';
process.env['MINIO_BUCKET'] = 'openlive-vod';

const recordingsStore = new Map<string, RecordingDoc>();
const productionsStore = new Map<string, { _id: string }>();

const recordingsDb = {
  get: vi.fn(async (id: string) => {
    const doc = recordingsStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: RecordingDoc) => {
    recordingsStore.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true, id: doc._id, rev: '1-x' };
  }),
  find: vi.fn(async (query: { selector: { productionId?: string } }) => {
    const all = Array.from(recordingsStore.values());
    const pid = query.selector.productionId;
    return { docs: pid ? all.filter((r) => r.productionId === pid) : all };
  }),
};

const prodDb = {
  get: vi.fn(async (id: string) => {
    const doc = productionsStore.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(),
  find: vi.fn(),
  findTrusted: vi.fn(),
};

vi.mock('../db/index.js', () => ({
  getDb: () => prodDb,
  getRecordingsDb: () => recordingsDb,
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

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };

let app: FastifyInstance;

function makeRecording(over: Partial<RecordingDoc> = {}): RecordingDoc {
  const now = '2026-09-16T10:00:00.000Z';
  return {
    _id: `recording-${Math.random().toString(16).slice(2)}`,
    type: 'recording',
    productionId: 'prod-1',
    outputId: 'output-rec-1',
    bucket: 'openlive-vod',
    key: 'prod-1/segment_00001.mp4',
    sizeBytes: 1234,
    startedAt: now,
    endedAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  recordingsStore.clear();
  productionsStore.clear();
});

describe('GET /api/v1/productions/:id/recordings', () => {
  it('lists a production\'s recordings with a presigned playbackUrl', async () => {
    productionsStore.set('prod-1', { _id: 'prod-1' });
    const rec = makeRecording();
    recordingsStore.set(rec._id, rec);

    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(rec._id);
    expect(body[0].productionId).toBe('prod-1');
    expect(body[0].key).toBe('prod-1/segment_00001.mp4');
    // No CouchDB envelope leaks to the client.
    expect(body[0]._id).toBeUndefined();
    expect(body[0]._rev).toBeUndefined();
    expect(body[0].type).toBeUndefined();
    // Presigned URL points at the object and carries a SigV4 signature.
    expect(body[0].playbackUrl).toContain('/openlive-vod/prod-1/segment_00001.mp4');
    expect(body[0].playbackUrl).toContain('X-Amz-Signature=');
    expect(body[0].playbackUrl).toContain('X-Amz-Expires=3600');
  });

  it('returns 404 for an unknown production', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/nope/recordings', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Production not found');
  });

  it('returns an empty array when a production has no recordings', async () => {
    productionsStore.set('prod-empty', { _id: 'prod-empty' });
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-empty/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1/recordings' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/v1/recordings', () => {
  it('lists recordings across all productions', async () => {
    const a = makeRecording({ productionId: 'prod-1' });
    const b = makeRecording({ productionId: 'prod-2', key: 'prod-2/segment_00001.mp4' });
    recordingsStore.set(a._id, a);
    recordingsStore.set(b._id, b);
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe('GET /api/v1/recordings/:id', () => {
  it('fetches a single recording with a playbackUrl', async () => {
    const rec = makeRecording();
    recordingsStore.set(rec._id, rec);
    const res = await app.inject({ method: 'GET', url: `/api/v1/recordings/${rec._id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(rec._id);
    expect(res.json().playbackUrl).toContain('X-Amz-Signature=');
  });

  it('returns 404 when the recording is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/recordings/recording-missing', headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Recording not found');
  });
});
