/**
 * The live part upload's listener follows the production lifecycle (issue
 * #556, same rule as #426): deactivate and production delete stop it before
 * their own teardown, and the deactivate sweep stamps the stopped session's
 * activationId and each part's partIndex on the RecordingDocs it writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockDestroy = vi.fn();
const mockRecInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, destroy: mockDestroy, find: vi.fn(), findTrusted: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: mockRecInsert }),
  getSourcesDb: () => ({ get: mockGet }),
  getGuestInvitesDb: () => ({ find: vi.fn(async () => ({ docs: [] })), destroy: vi.fn() }),
  getGuestSessionsDb: () => ({ find: vi.fn(async () => ({ docs: [] })), insert: vi.fn() }),
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

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

vi.mock('../lib/strom.js', () => ({
  StromClient: class {
    recorder = { splitNow: vi.fn().mockResolvedValue(undefined) };
  },
  StromClientError: class extends Error {},
}));

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return { ...actual, isRecordingEnabled: () => true };
});

const mockUploadRecordings = vi.fn();
vi.mock('../lib/recording-uploader.js', () => ({
  minioTargetFromConfig: () => ({
    endpoint: 'minio.local:9000', useSsl: false, region: 'us-east-1', accessKey: 'AK', secretKey: 's', bucket: 'vod',
  }),
  uploadRecordings: (...args: unknown[]) => mockUploadRecordings(...args),
}));

vi.mock('../services/guest-sweep.js', () => ({ sweepGuestsOnProductionEnd: vi.fn() }));

vi.mock('../services/gpu-usage.js', async (orig) => {
  const actual = await orig<typeof import('../services/gpu-usage.js')>();
  return { ...actual, preserveGpuUsageOnDelete: vi.fn() };
});

const order: string[] = [];
const mockStopLive = vi.fn();
vi.mock('../services/live-recording-upload.js', () => ({
  startLiveRecordingUpload: vi.fn(),
  stopLiveRecordingUpload: (...args: unknown[]) => mockStopLive(...args),
}));

import { buildServer } from '../server.js';

const STEM = 'prod-test-1_20261022_080000';

function makeProductionDoc() {
  return {
    _id: 'prod-test-1',
    _rev: '7-abc',
    type: 'production',
    name: 'Test Production',
    status: 'active',
    stromFlowId: 'flow-abc',
    recorderBlockId: 'rec-block-1',
    recording: { outputId: 'out-rec', startedAt: '2026-10-22T08:00:00.000Z' },
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mockGet.mockResolvedValue(makeProductionDoc());
  mockInsert.mockResolvedValue({ ok: true, rev: '8-def' });
  mockRecInsert.mockResolvedValue({ ok: true });
  mockDestroy.mockResolvedValue({ ok: true });
  mockDeactivateStromFlow.mockImplementation(async () => { order.push('flow-teardown'); });
  mockStopLive.mockImplementation(async () => {
    order.push('stop-live');
    return { activationId: 'flow-abc', stem: STEM };
  });
  mockUploadRecordings.mockImplementation(async () => {
    order.push('deactivate-sweep');
    return {
      uploaded: [
        { key: `prod-test-1/${STEM}_00004.mp4`, sizeBytes: 10, stromPath: 'x', startedAt: '2026-10-22T08:00:00.000Z' },
        { key: 'prod-test-1/prod-test-1_20261021_200000_00002.mp4', sizeBytes: 10, stromPath: 'y', startedAt: '2026-10-21T20:00:00.000Z' },
      ],
      failed: [],
    };
  });
});

describe('live part upload lifecycle (#556)', () => {
  it('deactivate stops the listener before its own upload sweep and the flow teardown', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });
    expect(res.statusCode).toBe(200);
    expect(mockStopLive).toHaveBeenCalledWith('prod-test-1');
    expect(order).toEqual(['stop-live', 'deactivate-sweep', 'flow-teardown']);
  });

  it('the deactivate sweep stamps activationId on this session\'s parts and partIndex on all', async () => {
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-test-1/deactivate' });
    const docs = mockRecInsert.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ activationId: 'flow-abc', partIndex: 4 });
    expect(docs[1]).toMatchObject({ partIndex: 2 });
    expect(docs[1]!['activationId']).toBeUndefined();
  });

  it('production delete stops the listener before the flow teardown', async () => {
    const app = await buildServer();
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/productions/prod-test-1' });
    expect(res.statusCode).toBe(204);
    expect(mockStopLive).toHaveBeenCalledWith('prod-test-1');
    expect(order).toEqual(['stop-live', 'flow-teardown']);
  });
});
