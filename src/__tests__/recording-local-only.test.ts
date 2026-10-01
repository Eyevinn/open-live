/**
 * Recording without object storage.
 *
 * Strom's recorder writes segments to its own media path; object storage only
 * adds the post-deactivate upload. So:
 *   - a `recording` output can be created with no MinIO vars set,
 *   - deactivate with no object storage tears down without splitNow/upload,
 *   - deactivate with object storage uploads as before,
 *   - a partial MinIO config is reported (startup warns) and does not upload,
 *   - the VOD endpoints return 503, since nothing was uploaded to list.
 *
 * Config is read at import time, so the tests flip the exported `config`
 * object's MinIO fields directly. CouchDB, Strom, and the uploader are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();
const mockFindTrusted = vi.fn();
const mockOutputGet = vi.fn();
const mockOutputInsert = vi.fn();
const mockOutputFind = vi.fn();
const mockRecordingInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind, findTrusted: mockFindTrusted }),
  getOutputsDb: () => ({ get: mockOutputGet, insert: mockOutputInsert, find: mockOutputFind, destroy: vi.fn() }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getRecordingsDb: () => ({ insert: mockRecordingInsert }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }), insert: vi.fn() }),
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
}));

const mockDeactivateStromFlow = vi.fn();
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

const mockSplitNow = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

const mockUploadRecordings = vi.fn();
vi.mock('../lib/recording-uploader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/recording-uploader.js')>();
  return { ...actual, uploadRecordings: (...args: unknown[]) => mockUploadRecordings(...args) };
});

import { buildServer } from '../server.js';
import { config, isObjectStorageConfigured, objectStorageMissingVars } from '../config.js';

const STORAGE = {
  minioEndpoint: 'http://minio.local:9000',
  minioAccessKey: 'AKIAEXAMPLE',
  minioSecretKey: 'secretexamplekey',
  minioBucket: 'openlive-vod',
} as const;

function setStorage(values: Partial<Record<keyof typeof STORAGE, string | undefined>>): void {
  for (const key of Object.keys(STORAGE) as Array<keyof typeof STORAGE>) {
    (config as Record<string, unknown>)[key] = values[key];
  }
}

function makeRecordingProduction() {
  return {
    _id: 'prod-rec-1',
    _rev: '3-abc',
    type: 'production',
    name: 'Recorded Production',
    status: 'active',
    sources: [],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    stromFlowId: 'flow-rec',
    recorderBlockId: 'recorder-1',
    outputAssignments: [{ outputId: 'output-rec', id: 'oa-1' }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setStorage({});
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
  mockOutputFind.mockResolvedValue({ docs: [] });
  mockOutputInsert.mockResolvedValue({ ok: true, id: 'x', rev: '1-x' });
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-rec-1', rev: '4-def' });
  mockDeactivateStromFlow.mockResolvedValue(undefined);
  mockSplitNow.mockResolvedValue(undefined);
  mockUploadRecordings.mockResolvedValue({ uploaded: [], failed: [] });
});

afterEach(() => {
  setStorage({});
});

describe('object storage config', () => {
  it('is not configured and reports nothing missing when no MinIO var is set', () => {
    expect(isObjectStorageConfigured()).toBe(false);
    expect(objectStorageMissingVars()).toEqual([]);
  });

  it('is configured when all four MinIO vars are set', () => {
    setStorage(STORAGE);
    expect(isObjectStorageConfigured()).toBe(true);
    expect(objectStorageMissingVars()).toEqual([]);
  });

  it('reports the missing vars of a partial config, which is not configured', () => {
    setStorage({ minioEndpoint: STORAGE.minioEndpoint, minioBucket: STORAGE.minioBucket });
    expect(isObjectStorageConfigured()).toBe(false);
    expect(objectStorageMissingVars()).toEqual(['MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY']);
  });
});

describe('POST /api/v1/outputs — recording without object storage', () => {
  it('creates a recording output when no MinIO var is set', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/outputs',
      payload: { name: 'Disk recording', outputType: 'recording' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).outputType).toBe('recording');
    expect(mockOutputInsert).toHaveBeenCalledOnce();
  });
});

describe('VOD endpoints without object storage', () => {
  it.each([
    '/api/v1/productions/prod-rec-1/recordings',
    '/api/v1/recordings',
    '/api/v1/recordings/recording-1',
  ])('GET %s returns 503', async (url) => {
    mockGet.mockResolvedValue(makeRecordingProduction());
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toBe('Object storage unavailable');
  });
});

describe('POST /api/v1/productions/:id/deactivate — recorder teardown', () => {
  it('skips splitNow and upload and still tears down when object storage is not configured', async () => {
    mockGet.mockResolvedValue(makeRecordingProduction());

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
    expect(mockSplitNow).not.toHaveBeenCalled();
    expect(mockUploadRecordings).not.toHaveBeenCalled();
    expect(mockRecordingInsert).not.toHaveBeenCalled();
    expect(mockDeactivateStromFlow).toHaveBeenCalledWith('flow-rec', expect.anything());
    expect(mockInsert.mock.calls[0][0].recorderBlockId).toBeUndefined();
  });

  it('skips upload when object storage is only partially configured', async () => {
    setStorage({ minioEndpoint: STORAGE.minioEndpoint, minioBucket: STORAGE.minioBucket });
    mockGet.mockResolvedValue(makeRecordingProduction());

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(mockUploadRecordings).not.toHaveBeenCalled();
    expect(mockDeactivateStromFlow).toHaveBeenCalledOnce();
  });

  it('finalises, uploads, and persists a RecordingDoc when object storage is configured', async () => {
    setStorage(STORAGE);
    mockGet.mockResolvedValue(makeRecordingProduction());
    mockOutputGet.mockResolvedValue({ _id: 'output-rec', outputType: 'recording' });
    mockUploadRecordings.mockResolvedValue({
      uploaded: [{ key: 'prod-rec-1/seg_00001.mp4', sizeBytes: 1024 }],
      failed: [],
    });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(mockSplitNow).toHaveBeenCalledWith('flow-rec', 'recorder-1');
    expect(mockUploadRecordings).toHaveBeenCalledOnce();
    const uploadArgs = mockUploadRecordings.mock.calls[0][0] as { outputDir: string; target: { bucket: string } };
    expect(uploadArgs.outputDir).toBe('recordings/prod-rec-1');
    expect(uploadArgs.target.bucket).toBe('openlive-vod');
    expect(mockRecordingInsert).toHaveBeenCalledOnce();
    expect(mockRecordingInsert.mock.calls[0][0]).toMatchObject({
      productionId: 'prod-rec-1',
      outputId: 'output-rec',
      bucket: 'openlive-vod',
      key: 'prod-rec-1/seg_00001.mp4',
    });
    expect(mockDeactivateStromFlow).toHaveBeenCalledOnce();
  });
});
