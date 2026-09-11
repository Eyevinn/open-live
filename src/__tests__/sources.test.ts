/**
 * Tests for the sources routes' handling of provider-owned (read-only) sources.
 *
 * CouchDB is mocked via vi.mock('../db/index.js') — no real database required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockDestroy = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, destroy: mockDestroy }),
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

const providerDoc = {
  _id: 'src-ext-weave-basic-0',
  _rev: '3-abc',
  type: 'source',
  name: 'basic',
  address: 'srt://172.27.0.10:20003?mode=caller',
  streamType: 'srt',
  status: 'active',
  provider: { id: 'weave', externalId: 'basic/0', syncedAt: '2026-09-01T00:00:00.000Z' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const manualDoc = {
  _id: 'src-11111111-1111-1111-1111-111111111111',
  _rev: '1-abc',
  type: 'source',
  name: 'Camera 1',
  address: 'srt://203.0.113.5:9000?mode=caller',
  streamType: 'srt',
  status: 'inactive',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue({ docs: [] });
});

describe('GET /api/v1/sources', () => {
  it('marks provider-owned sources readOnly and exposes the provider reference', async () => {
    mockFind.mockResolvedValue({ docs: [providerDoc, manualDoc] });
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sources' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      id: providerDoc._id,
      readOnly: true,
      provider: providerDoc.provider,
      address: providerDoc.address,
    });
    expect(body[1].id).toBe(manualDoc._id);
    expect(body[1]).not.toHaveProperty('readOnly');
    expect(body[1]).not.toHaveProperty('provider');
  });
});

describe('PATCH /api/v1/sources/:id', () => {
  it('returns 409 for a provider-owned source and writes nothing', async () => {
    mockGet.mockResolvedValue(providerDoc);
    const app = await buildServer();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${providerDoc._id}`,
      payload: { name: 'renamed' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Source is managed by provider weave' });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('still updates a manually created source', async () => {
    mockGet.mockResolvedValue(manualDoc);
    mockInsert.mockResolvedValue({ ok: true, id: manualDoc._id, rev: '2-def' });
    const app = await buildServer();
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sources/${manualDoc._id}`,
      payload: { name: 'Camera 1b' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Camera 1b');
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/v1/sources/:id', () => {
  it('returns 409 for a provider-owned source and does not destroy it', async () => {
    mockGet.mockResolvedValue(providerDoc);
    const app = await buildServer();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/sources/${providerDoc._id}` });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'Source is managed by provider weave' });
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('still deletes a manually created source', async () => {
    mockGet.mockResolvedValue(manualDoc);
    mockDestroy.mockResolvedValue({ ok: true });
    const app = await buildServer();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/sources/${manualDoc._id}` });

    expect(res.statusCode).toBe(204);
    expect(mockDestroy).toHaveBeenCalledWith(manualDoc._id, manualDoc._rev);
  });
});
