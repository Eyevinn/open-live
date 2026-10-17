/**
 * Deactivate's upload sweep takes every segment under the production's Strom
 * recordings directory, including ones earlier sessions left there (recorded
 * without object storage, or whose upload failed). Each RecordingDoc must carry
 * the start of the session that recorded it, not the current one's.
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
const mockMediaList = vi.fn();
const mockDeleteFile = vi.fn();
const mockDeleteDir = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    flows = { list: vi.fn(), get: vi.fn(), start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    recorder = { splitNow: mockSplitNow };
    media = { list: mockMediaList, deleteFile: mockDeleteFile, deleteDirectory: mockDeleteDir };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

import { buildServer } from '../server.js';
import { config } from '../config.js';

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

// This activation started 2026-03-01 and is the first with object storage.
// Sessions on 2026-01-10 and 2026-02-05 ran without it, so their segments are
// still on Strom. Strom names segments {filename_prefix}_{YYYYmmdd_HHMMSS}_%05d.
function prod() {
  return {
    _id: 'prod-rec-1', _rev: '3-abc', type: 'production', name: 'P', status: 'active',
    sources: [], pipeline: { stromConfig: null, status: 'running' }, graphics: [], macros: [],
    tally: { pgm: null, pvw: null }, stromFlowId: 'flow-rec', recorderBlockId: 'recorder-1',
    outputAssignments: [{ outputId: 'output-rec', id: 'oa-1' }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z',
  };
}
const FILES = [
  'recording_20260110_090000_00000.mp4',
  'recording_20260110_090000_00001.mp4',
  'recording_20260205_183015_00000.mp4',
  'recording_20260301_100002_00000.mp4',
  // No timestamp in the name: nothing to read a start from.
  'legacy_00000.mp4',
];

beforeEach(() => {
  vi.clearAllMocks();
  setStorage(STORAGE);
  mockFind.mockResolvedValue({ docs: [] });
  mockFindTrusted.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ ok: true, id: 'prod-rec-1', rev: '4-def' });
  mockOutputGet.mockResolvedValue({ _id: 'output-rec', outputType: 'recording' });
  mockDeactivateStromFlow.mockResolvedValue(undefined);
  mockSplitNow.mockResolvedValue(undefined);
  mockRecordingInsert.mockResolvedValue({ ok: true });
  mockDeleteFile.mockResolvedValue({});
  mockDeleteDir.mockResolvedValue({});
  mockMediaList.mockResolvedValue({
    entries: FILES.map((name) => ({ name, path: `recordings/prod-rec-1/${name}`, is_dir: false })),
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return new Response('', { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }));
});
afterEach(() => { setStorage({}); vi.unstubAllGlobals(); });

describe('deactivate — RecordingDoc.startedAt for segments left by earlier sessions', () => {
  it('stamps each RecordingDoc with the start of the session that recorded it', async () => {
    mockGet.mockResolvedValue(prod());
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-rec-1/deactivate' });
    expect(res.statusCode).toBe(200);

    const docs = mockRecordingInsert.mock.calls.map((c) => c[0] as { key: string; startedAt: string });
    expect(Object.fromEntries(docs.map((d) => [d.key, d.startedAt]))).toEqual({
      'prod-rec-1/recording_20260110_090000_00000.mp4': '2026-01-10T09:00:00.000Z',
      'prod-rec-1/recording_20260110_090000_00001.mp4': '2026-01-10T09:00:00.000Z',
      'prod-rec-1/recording_20260205_183015_00000.mp4': '2026-02-05T18:30:15.000Z',
      'prod-rec-1/recording_20260301_100002_00000.mp4': '2026-03-01T10:00:02.000Z',
      // Falls back to this activation's start.
      'prod-rec-1/legacy_00000.mp4': '2026-03-01T10:00:00.000Z',
    });
  });
});
