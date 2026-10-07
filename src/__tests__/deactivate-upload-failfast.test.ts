/**
 * Deactivate teardown must not be held hostage by the VOD upload sweep (#465).
 *
 * When object storage rejects our credentials, `uploadRecordings` short-circuits
 * (it returns `abortedOnAuthError` rather than grinding through — and re-failing —
 * every segment). This test pins the route contract around that: the deactivate
 * handler logs the abort, then still runs the Strom flow teardown and the guest
 * sweep, and returns 200. CouchDB, Strom and the uploader are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGet = vi.fn();
const mockInsert = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: vi.fn(), findTrusted: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn(), destroy: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), find: vi.fn(), insert: vi.fn() }),
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

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// Avoid a real StromClient (and the recorder.splitNow network call).
vi.mock('../lib/strom.js', () => ({
  StromClient: class {
    recorder = { splitNow: vi.fn().mockResolvedValue(undefined) };
  },
  StromClientError: class extends Error {},
}));

// Recording is enabled; everything else in config is left real.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>();
  return { ...actual, isRecordingEnabled: () => true };
});

// The uploader reports an auth-aborted sweep (as it now does on a 401/403 or an
// S3 InvalidAccessKeyId/AccessDenied/SignatureDoesNotMatch from the store).
const mockUploadRecordings = vi.fn();
vi.mock('../lib/recording-uploader.js', () => ({
  minioTargetFromConfig: () => ({
    endpoint: 'minio.local:9000',
    useSsl: false,
    region: 'us-east-1',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'secret',
    bucket: 'vod',
  }),
  uploadRecordings: (...args: unknown[]) => mockUploadRecordings(...args),
}));

const mockSweepGuests = vi.fn();
vi.mock('../services/guest-sweep.js', () => ({
  sweepGuestsOnProductionEnd: (...args: unknown[]) => mockSweepGuests(...args),
}));

import { buildServer } from '../server.js';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-test-1',
    _rev: '115-abc',
    type: 'production',
    name: 'Test Production',
    status: 'active',
    stromFlowId: 'flow-abc',
    recorderBlockId: 'rec-block-1',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const url = '/api/v1/productions/prod-test-1/deactivate';

beforeEach(() => {
  vi.clearAllMocks();
  mockGet.mockReset();
  mockInsert.mockReset();
  mockDeactivateStromFlow.mockReset();
  mockSweepGuests.mockReset();
  mockUploadRecordings.mockReset();
});

describe('deactivate with an auth-aborted upload sweep (#465)', () => {
  it('still tears down the Strom flow and sweeps guests, and returns 200', async () => {
    mockGet.mockResolvedValue(makeProductionDoc());
    mockInsert.mockResolvedValue({ ok: true, id: 'prod-test-1', rev: '116-def' });
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockSweepGuests.mockResolvedValue(undefined);
    mockUploadRecordings.mockResolvedValue({
      uploaded: [],
      failed: [{ file: 'recordings/prod-test-1/seg_00001.mp4', error: 'S3 PutObject failed: 403 AccessDenied' }],
      abortedOnAuthError: { file: 'recordings/prod-test-1/seg_00001.mp4', code: 'AccessDenied' },
    });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: 'prod-test-1', status: 'ended' });
    // The aborted sweep did not prevent teardown.
    expect(mockUploadRecordings).toHaveBeenCalledTimes(1);
    expect(mockDeactivateStromFlow).toHaveBeenCalledTimes(1);
    expect(mockSweepGuests).toHaveBeenCalledTimes(1);
  });
});
