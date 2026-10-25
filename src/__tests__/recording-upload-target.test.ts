/**
 * Recording upload target and outcome (issue #534).
 *
 * - Activation snapshots the recording output's storage connection on the
 *   production (`recording`), and deactivate uploads to that snapshot even when
 *   the output was removed from the production while it was live.
 * - Deactivate stores `lastRecordingUpload` (uploaded count, failed files, the
 *   connection used, and a reason when nothing or not everything was uploaded).
 *
 * No `MINIO_*` env is set: the instance stores recordings only in a storage
 * connection. CouchDB, Strom, the flow generator and the uploader are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OutputDoc, ProductionDoc, RecordingDoc, StorageConnectionDoc } from '../db/types.js';

delete process.env['MINIO_ENDPOINT'];
delete process.env['MINIO_ACCESS_KEY'];
delete process.env['MINIO_SECRET_KEY'];
delete process.env['MINIO_BUCKET'];
process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

const productions = new Map<string, ProductionDoc>();
const outputs = new Map<string, OutputDoc>();
const connections = new Map<string, StorageConnectionDoc>();
const recordingInserts: RecordingDoc[] = [];
const productionInserts: ProductionDoc[] = [];
let rev = 1;

function notFound(): Error {
  return Object.assign(new Error('not_found'), { statusCode: 404 });
}

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = productions.get(id);
      if (!doc) throw notFound();
      return structuredClone(doc);
    }),
    insert: vi.fn(async (doc: ProductionDoc) => {
      const stored = JSON.parse(JSON.stringify({ ...doc, _rev: `${++rev}-x` })) as ProductionDoc;
      productions.set(doc._id, stored);
      productionInserts.push(stored);
      return { ok: true, id: doc._id, rev: stored._rev };
    }),
    find: vi.fn(async () => ({ docs: [] })),
    findTrusted: vi.fn(async () => ({ docs: [] })),
  }),
  getOutputsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = outputs.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    find: vi.fn(), insert: vi.fn(), destroy: vi.fn(),
  }),
  getRecordingsDb: () => ({
    get: vi.fn(), find: vi.fn(),
    insert: vi.fn(async (doc: RecordingDoc) => {
      recordingInserts.push(doc);
      return { ok: true, id: doc._id, rev: '1-x' };
    }),
  }),
  getStorageConnectionsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = connections.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
  }),
  getSourcesDb: () => ({ get: vi.fn(async () => { throw notFound(); }) }),
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
  reinitConnectedControllers: vi.fn().mockResolvedValue(undefined),
}));

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue('test-token') }));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  return {
    ...actual,
    StromClient: class {
      flows = { get: vi.fn().mockResolvedValue({ flow: { id: 'flow-1', running: true, blocks: [] } }) };
      mixer = { multiviewEndpoint: vi.fn().mockResolvedValue(null) };
      recorder = { splitNow: vi.fn().mockResolvedValue(undefined) };
    },
  };
});

vi.mock('../services/guest-sweep.js', () => ({ sweepGuestsOnProductionEnd: vi.fn().mockResolvedValue(undefined) }));

const mockUploadRecordings = vi.fn();
vi.mock('../lib/recording-uploader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/recording-uploader.js')>();
  return { ...actual, uploadRecordings: (...args: unknown[]) => mockUploadRecordings(...args) };
});

const broadcasts: Array<Record<string, unknown>> = [];
vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (id: string, msg: Record<string, unknown>) => {
      broadcasts.push(msg);
      return actual.broadcast(id, msg as never);
    },
  };
});

const { buildServer } = await import('../server.js');
const { stopLiveRecordingUpload } = await import('../services/live-recording-upload.js');
const { encryptStorageSecret } = await import('../lib/storage-connection-crypto.js');

const NOW = '2026-10-19T10:00:00.000Z';

function production(over: Partial<ProductionDoc> = {}): ProductionDoc {
  return {
    _id: 'prod-1',
    _rev: '1-x',
    type: 'production',
    name: 'Show',
    status: 'inactive',
    sources: [],
    outputAssignments: [{ outputId: 'output-rec' }],
    tally: { pgm: null, pvw: null },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as ProductionDoc;
}

function activationResult() {
  return {
    flowId: 'flow-1',
    mixerBlockId: null,
    audioMixerBlockId: null,
    loudnessMainBlockId: null,
    recorderBlockId: 'b-out-rec',
    recorderOutputId: 'output-rec',
    whepOutputEntries: undefined,
    pgmWhepEndpointId: undefined,
    warnings: [],
    sourceOffsetBlockIds: {},
    sourceAudioOffsetBlockIds: {},
    clipPlayerBlockIds: {},
    returnBuses: [],
    returnWhepEntries: [],
    mixerInputMap: {},
  };
}

beforeEach(() => {
  productions.clear();
  outputs.clear();
  connections.clear();
  recordingInserts.length = 0;
  productionInserts.length = 0;
  mockUploadRecordings.mockReset();
  mockActivateStromFlow.mockReset();
  outputs.set('output-rec', {
    _id: 'output-rec', type: 'output', name: 'VOD', outputType: 'recording',
    connectionId: 'stconn-C', createdAt: NOW, updatedAt: NOW,
  });
  connections.set('stconn-C', {
    _id: 'stconn-C', type: 'storage-connection', name: 'Tenant S3', endpoint: 's3.tenant.example.com',
    useSsl: true, region: 'eu-west-1', accessKey: 'AKTENANT', secretKeyEnc: encryptStorageSecret('tenant-secret'),
    defaultBucket: 'tenant-vod', role: 'recording', createdAt: NOW, updatedAt: NOW,
  });
});

afterAll(() => {
  delete process.env['STORAGE_CONNECTION_KEY'];
});

describe('recorderType on the production (OL-32a)', () => {
  it('persists the activation recorder type with the recorder block and clears it on deactivate', async () => {
    productions.set('prod-1', production());
    mockActivateStromFlow.mockResolvedValue({ ...activationResult(), recorderType: 'liverecorder' });
    mockUploadRecordings.mockResolvedValue({ uploaded: [], failed: [] });
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/activate' });
    await vi.waitFor(() => expect(productions.get('prod-1')?.status).toBe('active'));
    expect(productions.get('prod-1')).toMatchObject({ recorderBlockId: 'b-out-rec', recorderType: 'liverecorder' });

    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(res.statusCode).toBe(200);
    expect(productions.get('prod-1')?.recorderType).toBeUndefined();
  });

  it('writes no recorderType without a recorder block', async () => {
    productions.set('prod-1', production({ recorderType: 'recorder' } as Partial<ProductionDoc>));
    mockActivateStromFlow.mockResolvedValue({ ...activationResult(), recorderBlockId: undefined, recorderOutputId: undefined });
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/activate' });
    await vi.waitFor(() => expect(productions.get('prod-1')?.status).toBe('active'));
    expect(productions.get('prod-1')?.recorderType).toBeUndefined();
  });
});

describe('input recordings on the production (OL-32, spec §3.2, §2.8)', () => {
  const inputRecorder = {
    mixerInput: 'video_in_2', sourceId: 'src-srt', sourceName: 'Camera 2', streamType: 'srt' as const,
    recorderBlockId: 'b-inrec-2-x', outputDir: 'recordings/prod-1/video_in_2',
  };

  it('persists inputRecordings, starts a live session per input and broadcasts RECORDING_STATE after the warnings', async () => {
    broadcasts.length = 0;
    productions.set('prod-1', production());
    mockActivateStromFlow.mockResolvedValue({
      ...activationResult(),
      recorderType: 'liverecorder',
      inputRecorders: [inputRecorder],
      warnings: [{ type: 'input-recording-capped', mixerInputs: ['video_in_9'], message: 'capped' }],
    });
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/activate' });
    await vi.waitFor(() => expect(productions.get('prod-1')?.status).toBe('active'));
    expect(productions.get('prod-1')?.inputRecordings).toEqual([inputRecorder]);

    const types = broadcasts.map((b) => b['type']);
    expect(types.indexOf('ERROR')).toBeLessThan(types.indexOf('RECORDING_STATE'));
    expect(broadcasts.find((b) => b['type'] === 'RECORDING_STATE')).toMatchObject({
      program: true,
      inputs: [{ mixerInput: 'video_in_2', sourceId: 'src-srt', sourceName: 'Camera 2' }],
    });

    const session = await stopLiveRecordingUpload('prod-1');
    expect([...(session?.inputs?.keys() ?? [])]).toEqual(['video_in_2']);
  });

  it('writes no inputRecordings when none are recorded, clearing a stale list', async () => {
    broadcasts.length = 0;
    productions.set('prod-1', production({ inputRecordings: [inputRecorder] }));
    mockActivateStromFlow.mockResolvedValue(activationResult());
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/activate' });
    await vi.waitFor(() => expect(productions.get('prod-1')?.status).toBe('active'));
    expect(productions.get('prod-1')?.inputRecordings).toBeUndefined();
    expect(broadcasts.find((b) => b['type'] === 'RECORDING_STATE')).toMatchObject({ program: true, inputs: [] });
    await stopLiveRecordingUpload('prod-1');
  });
});

describe('recording upload target snapshot (issue #534)', () => {
  it('uploads to the activation-time connection after the output is removed from the live production', async () => {
    productions.set('prod-1', production());
    mockActivateStromFlow.mockResolvedValue(activationResult());
    mockUploadRecordings.mockResolvedValue({
      uploaded: [{
        key: 'prod-1/prod-1_20261019_100000_00000.mp4',
        sizeBytes: 2048,
        stromPath: 'recordings/prod-1/prod-1_20261019_100000_00000.mp4',
        startedAt: '2026-10-19T10:00:00.000Z',
        durationMs: 61_000,
      }],
      failed: [],
    });

    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/activate' });
    await vi.waitFor(() => expect(productions.get('prod-1')?.status).toBe('active'));

    const live = productions.get('prod-1')!;
    expect(live.recording).toMatchObject({ outputId: 'output-rec', connectionId: 'stconn-C' });
    expect(Date.parse(live.recording!.startedAt)).not.toBeNaN();

    // The operator removes the recording output while the production is live.
    productions.set('prod-1', { ...live, outputAssignments: [] });

    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(res.statusCode).toBe(200);

    expect(mockUploadRecordings).toHaveBeenCalledTimes(1);
    const args = mockUploadRecordings.mock.calls[0]![0] as { target: { bucket: string; endpoint: string; accessKey: string } };
    expect(args.target).toMatchObject({ bucket: 'tenant-vod', endpoint: 's3.tenant.example.com', accessKey: 'AKTENANT' });

    expect(recordingInserts).toHaveLength(1);
    expect(recordingInserts[0]).toMatchObject({
      productionId: 'prod-1',
      outputId: 'output-rec',
      connectionId: 'stconn-C',
      bucket: 'tenant-vod',
      durationMs: 61_000,
      startedAt: '2026-10-19T10:00:00.000Z',
    });

    const stopped = productions.get('prod-1')!;
    expect(stopped.recording).toBeUndefined();
    expect(stopped.lastRecordingUpload).toMatchObject({
      outputId: 'output-rec',
      connectionId: 'stconn-C',
      bucket: 'tenant-vod',
      uploaded: 1,
      failed: [],
    });
    expect(stopped.lastRecordingUpload!.reason).toBeUndefined();

    // Returned by GET /api/v1/productions/:id, with no secrets in it.
    const got = await app.inject({ method: 'GET', url: '/api/v1/productions/prod-1' });
    expect(got.json().lastRecordingUpload.uploaded).toBe(1);
    expect(JSON.stringify(got.json().lastRecordingUpload)).not.toContain('tenant-secret');
    await app.close();
  });

  it('gives each part of one session its own consecutive startedAt/endedAt (#553)', async () => {
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', connectionId: 'stconn-C', startedAt: '2026-10-19T09:59:58.000Z' },
    }));
    const part = (i: number, durationMs: number) => ({
      key: `prod-1/prod-1_20261019_100000_0000${i}.mp4`,
      sizeBytes: 1,
      stromPath: `recordings/prod-1/prod-1_20261019_100000_0000${i}.mp4`,
      startedAt: '2026-10-19T10:00:00.000Z',
      durationMs,
    });
    // Listing order from Strom is not guaranteed; part 2 comes first here.
    mockUploadRecordings.mockResolvedValue({ uploaded: [part(2, 15_000), part(0, 60_000), part(1, 60_000)], failed: [] });
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    const byKey = new Map(recordingInserts.map((r) => [r.key, r]));
    const docs = [0, 1, 2].map((i) => byKey.get(`prod-1/prod-1_20261019_100000_0000${i}.mp4`)!);
    expect(docs.map((d) => [d.startedAt, d.endedAt])).toEqual([
      ['2026-10-19T10:00:00.000Z', '2026-10-19T10:01:00.000Z'],
      ['2026-10-19T10:01:00.000Z', '2026-10-19T10:02:00.000Z'],
      ['2026-10-19T10:02:00.000Z', '2026-10-19T10:02:15.000Z'],
    ]);
    await app.close();
  });

  it('falls back to the recording session start from the activation when the file name carries none', async () => {
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', connectionId: 'stconn-C', startedAt: '2026-10-19T09:59:58.000Z' },
    }));
    mockUploadRecordings.mockResolvedValue({
      uploaded: [{ key: 'prod-1/seg.mp4', sizeBytes: 1, stromPath: 'recordings/prod-1/seg.mp4' }],
      failed: [],
    });
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(recordingInserts[0]!.startedAt).toBe('2026-10-19T09:59:58.000Z');
    expect(recordingInserts[0]!.durationMs).toBeUndefined();
    await app.close();
  });

  it('records an auth-error reason and the failed file when the store rejects the key', async () => {
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', connectionId: 'stconn-C', startedAt: NOW },
    }));
    const file = 'recordings/prod-1/prod-1_20261019_100000_00000.mp4';
    mockUploadRecordings.mockResolvedValue({
      uploaded: [],
      failed: [{ file, error: 'S3 PutObject failed: 403 <Code>AccessDenied</Code>' }],
      abortedOnAuthError: { file, code: 'AccessDenied' },
    });

    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(res.statusCode).toBe(200);
    expect(mockDeactivateStromFlow).toHaveBeenCalled();
    expect(recordingInserts).toHaveLength(0);

    const summary = productions.get('prod-1')!.lastRecordingUpload!;
    expect(summary.uploaded).toBe(0);
    expect(summary.failed).toEqual([{ file, error: expect.stringContaining('AccessDenied') }]);
    expect(summary.reason).toBe('auth-error');
    expect(summary.message).toContain('AccessDenied');
    expect(summary.connectionId).toBe('stconn-C');
    await app.close();
  });

  it('records connection-not-found and uploads nothing when the snapshot connection is gone', async () => {
    connections.clear();
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', connectionId: 'stconn-C', startedAt: NOW },
    }));
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(mockUploadRecordings).not.toHaveBeenCalled();
    expect(productions.get('prod-1')!.lastRecordingUpload).toMatchObject({
      uploaded: 0, failed: [], reason: 'connection-not-found',
    });
    await app.close();
  });

  it('records no-storage-target when the output has no connection and MINIO_* is not configured', async () => {
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', startedAt: NOW },
    }));
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(mockUploadRecordings).not.toHaveBeenCalled();
    const summary = productions.get('prod-1')!.lastRecordingUpload!;
    expect(summary.reason).toBe('no-storage-target');
    expect(summary.message).toContain('MINIO_*');
    await app.close();
  });

  it('falls back to the assigned output connection for a production activated before the snapshot existed', async () => {
    // Legacy shape: recorderBlockId set, no `recording` snapshot. The assigned
    // recording output names stconn-C, so the upload must go there.
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
    }));
    expect(productions.get('prod-1')!.recording).toBeUndefined();
    mockUploadRecordings.mockResolvedValue({
      uploaded: [{ key: 'prod-1/seg.mp4', sizeBytes: 1, stromPath: 'recordings/prod-1/seg.mp4' }],
      failed: [],
    });
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(res.statusCode).toBe(200);
    expect(mockUploadRecordings).toHaveBeenCalledTimes(1);
    const args = mockUploadRecordings.mock.calls[0]![0] as { target: { bucket: string; endpoint: string; accessKey: string } };
    expect(args.target).toMatchObject({ bucket: 'tenant-vod', endpoint: 's3.tenant.example.com', accessKey: 'AKTENANT' });
    expect(recordingInserts[0]).toMatchObject({ outputId: 'output-rec', connectionId: 'stconn-C', bucket: 'tenant-vod' });
    expect(productions.get('prod-1')!.lastRecordingUpload).toMatchObject({
      outputId: 'output-rec', connectionId: 'stconn-C', uploaded: 1,
    });
    await app.close();
  });

  it('passes an isStillRecording guard that reports true once the stored _rev changes (#366)', async () => {
    productions.set('prod-1', production({
      status: 'active', stromFlowId: 'flow-1', recorderBlockId: 'b-out-rec',
      recording: { outputId: 'output-rec', connectionId: 'stconn-C', startedAt: NOW },
    }));
    let guardBefore: boolean | undefined;
    let guardAfter: boolean | undefined;
    mockUploadRecordings.mockImplementation(async (opts: { isStillRecording: () => Promise<boolean> }) => {
      // Unchanged _rev: the activation being torn down is not live any more.
      guardBefore = await opts.isStillRecording();
      // Something (e.g. a reactivation) writes the production mid-upload.
      const current = productions.get('prod-1')!;
      productions.set('prod-1', { ...current, _rev: `${++rev}-reactivated` });
      guardAfter = await opts.isStillRecording();
      return { uploaded: [], failed: [] };
    });
    const app = await buildServer();
    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(res.statusCode).toBe(200);
    expect(mockUploadRecordings).toHaveBeenCalledTimes(1);
    expect(guardBefore).toBe(false);
    expect(guardAfter).toBe(true);
    await app.close();
  });

  it('keeps the previous summary when a deactivate has no recording', async () => {
    const previous = { finishedAt: NOW, uploaded: 2, failed: [] };
    productions.set('prod-1', production({ status: 'active', stromFlowId: 'flow-1', lastRecordingUpload: previous }));
    const app = await buildServer();
    await app.inject({ method: 'POST', url: '/api/v1/productions/prod-1/deactivate' });
    expect(productions.get('prod-1')!.lastRecordingUpload).toEqual(previous);
    await app.close();
  });
});
