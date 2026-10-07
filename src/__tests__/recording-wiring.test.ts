/**
 * Tests for the MinIO config + Strom recorder wiring slice (issue #41).
 *
 *  - flow-generator emits a builtin.recorder block wired to PGM + main audio and
 *    returns recorderBlockId when a 'recording' output is assigned.
 *  - the upload-from-local uploader signs a SigV4 PutObject and pushes every
 *    local Strom segment to MinIO/S3, tolerating per-segment failures.
 *
 * Strom + object storage are fully mocked — no real services required.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-test-123' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

function makeProduction(
  sources: Array<{ sourceId: string; mixerInput: string }>,
) {
  return {
    _id: 'prod-rec-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Rec Production',
    status: 'inactive',
    sources,
    graphicAssignments: [],
    values: {},
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const recordingOutput = {
  _id: 'output-rec-abc12345',
  type: 'output' as const,
  outputType: 'recording' as const,
  name: 'VOD Recording',
  createdAt: '',
  updatedAt: '',
};

describe('flow-generator — recorder wiring (#41)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits a builtin.recorder block wired to PGM + main audio and returns recorderBlockId', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    const result = await activateStromFlow(
      production as never,
      strom as never,
      'http://localhost:7000',
      [recordingOutput] as never,
    );

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const links = flow['links'] as Array<Record<string, unknown>>;

    const recorder = blocks.find((b) => b['block_definition_id'] === 'builtin.recorder');
    expect(recorder).toBeDefined();
    const recId = recorder!['id'] as string;
    expect(result.recorderBlockId).toBe(recId);
    // output_dir is keyed by production id so segments are locatable for upload
    expect((recorder!['properties'] as Record<string, unknown>)['output_dir']).toBe(
      'recordings/prod-rec-1',
    );
    expect(result.recorderOutputDir).toBe('recordings/prod-rec-1');

    // Recorder receives the PGM video feed and the main audio bus
    const videoIn = links.find((l) => l['to'] === `${recId}:video_in`);
    const audioIn = links.find((l) => l['to'] === `${recId}:audio_in_0`);
    expect(videoIn).toBeDefined();
    expect(audioIn).toBeDefined();
  });

  it('wires at most one recorder block even if two recording outputs are assigned', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    await activateStromFlow(
      production as never,
      strom as never,
      'http://localhost:7000',
      [recordingOutput, { ...recordingOutput, _id: 'output-rec-def67890' }] as never,
    );

    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    const recorders = blocks.filter((b) => b['block_definition_id'] === 'builtin.recorder');
    expect(recorders).toHaveLength(1);
  });

  it('emits no recorder block when no recording output is assigned', async () => {
    const { activateStromFlow } = await import('../lib/flow-generator.js');
    const strom = makeStromClient();
    const production = makeProduction([{ sourceId: '__test1__', mixerInput: 'video_in_1' }]);

    const result = await activateStromFlow(production as never, strom as never);
    const flow = strom.capturedFlows[0]!;
    const blocks = flow['blocks'] as Array<Record<string, unknown>>;
    expect(blocks.find((b) => b['block_definition_id'] === 'builtin.recorder')).toBeUndefined();
    expect(result.recorderBlockId).toBeUndefined();
  });
});

describe('recording-uploader — SigV4 PutObject + upload-from-local (#41)', () => {
  const target = {
    endpoint: 'minio.local:9000',
    useSsl: false,
    region: 'us-east-1',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'secretExampleKey',
    bucket: 'vod',
  };

  afterEach(() => vi.unstubAllGlobals());

  it('signs a PutObject with AWS SigV4 and PUTs to path-style bucket URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const { putObject } = await import('../lib/recording-uploader.js');
    await putObject(target, 'prod-rec-1/seg_00001.mp4', Buffer.from('hello'), 'video/mp4',
      new Date('2026-09-15T13:00:00.000Z'));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://minio.local:9000/vod/prod-rec-1/seg_00001.mp4');
    expect(opts.method).toBe('PUT');
    const auth = opts.headers.Authorization as string;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260915\/us-east-1\/s3\/aws4_request/);
    expect(auth).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(opts.headers['x-amz-date']).toBe('20260915T130000Z');
    // payload hash of "hello"
    expect(opts.headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('throws when the object store rejects the PUT', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'AccessDenied' }));
    const { putObject } = await import('../lib/recording-uploader.js');
    await expect(putObject(target, 'k', Buffer.from('x'))).rejects.toThrow(/403/);
  });

  function makeStromMediaClient(entries: Array<Record<string, unknown>>) {
    return {
      media: {
        list: vi.fn().mockResolvedValue({ entries }),
        deleteFile: vi.fn().mockResolvedValue({ success: true }),
        deleteDirectory: vi.fn().mockResolvedValue({ success: true }),
      },
    };
  }

  function stubDownloadAndPutFetch(failOn?: string) {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/file/')) {
        if (failOn && url.includes(failOn)) {
          return Promise.resolve({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) });
        }
        return Promise.resolve({ ok: true, arrayBuffer: async () => new TextEncoder().encode('data').buffer });
      }
      // S3 PUT
      return Promise.resolve({ ok: true, text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('downloads every segment from Strom and uploads it, collecting per-file failures', async () => {
    stubDownloadAndPutFetch('seg_00002');

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
      { name: 'seg_00002.mp4', path: 'recordings/prod-rec-1/seg_00002.mp4', is_dir: false, size: 4 },
      { name: 'sub', path: 'recordings/prod-rec-1/sub', is_dir: true },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => false,
    });

    expect(strom.media.list).toHaveBeenCalledWith('recordings/prod-rec-1');
    // seg_00001 uploaded, seg_00002 failed on download, directory skipped
    expect(res.uploaded.map((u) => u.key)).toEqual(['prod-rec-1/seg_00001.mp4']);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.file).toBe('recordings/prod-rec-1/seg_00002.mp4');
  });

  it('deletes a successfully uploaded segment from Strom (issue #366)', async () => {
    stubDownloadAndPutFetch();

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => false,
    });

    expect(res.uploaded).toHaveLength(1);
    expect(strom.media.deleteFile).toHaveBeenCalledWith('recordings/prod-rec-1/seg_00001.mp4');
    // Every listed file uploaded + deleted successfully — folder is now empty.
    expect(strom.media.deleteDirectory).toHaveBeenCalledWith('recordings/prod-rec-1');
  });

  it('keeps a failed segment on Strom and skips directory cleanup (issue #366)', async () => {
    stubDownloadAndPutFetch('seg_00002');

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
      { name: 'seg_00002.mp4', path: 'recordings/prod-rec-1/seg_00002.mp4', is_dir: false, size: 4 },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => false,
    });

    expect(res.uploaded).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
    // Only the successfully uploaded segment is deleted; the failed one's local
    // copy is the only remaining copy and must survive for the next retry.
    expect(strom.media.deleteFile).toHaveBeenCalledTimes(1);
    expect(strom.media.deleteFile).toHaveBeenCalledWith('recordings/prod-rec-1/seg_00001.mp4');
    // Directory is non-empty (the failed segment is still there) — never attempt cleanup.
    expect(strom.media.deleteDirectory).not.toHaveBeenCalled();
  });

  it('skips delete entirely when the activation is still live/recording (issue #366)', async () => {
    stubDownloadAndPutFetch();

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => true,
    });

    // Upload still happens (registration must succeed independent of the guard)...
    expect(res.uploaded).toHaveLength(1);
    // ...but nothing is deleted while the activation may still be live.
    expect(strom.media.deleteFile).not.toHaveBeenCalled();
    expect(strom.media.deleteDirectory).not.toHaveBeenCalled();
  });

  it('aborts the sweep on the first object-store auth failure instead of re-PUTting every segment (#465)', async () => {
    // Downloads always succeed; the S3 PUT is rejected with a 403 /
    // InvalidAccessKeyId — a deterministic credential failure that would hit
    // every remaining segment identically.
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/file/')) {
        return Promise.resolve({ ok: true, arrayBuffer: async () => new TextEncoder().encode('data').buffer });
      }
      return Promise.resolve({
        ok: false,
        status: 403,
        text: async () => '<Error><Code>InvalidAccessKeyId</Code></Error>',
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
      { name: 'seg_00002.mp4', path: 'recordings/prod-rec-1/seg_00002.mp4', is_dir: false, size: 4 },
      { name: 'seg_00003.mp4', path: 'recordings/prod-rec-1/seg_00003.mp4', is_dir: false, size: 4 },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => false,
    });

    // Only the first segment was attempted: one download + one PUT. The other
    // two segments were never downloaded or re-PUT.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('seg_00002'))).toBe(false);
    expect(fetchMock.mock.calls.some(([u]) => (u as string).includes('seg_00003'))).toBe(false);

    expect(res.uploaded).toHaveLength(0);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.file).toBe('recordings/prod-rec-1/seg_00001.mp4');
    expect(res.abortedOnAuthError).toEqual({
      file: 'recordings/prod-rec-1/seg_00001.mp4',
      code: 'InvalidAccessKeyId',
    });
    // Nothing uploaded + failures present → no deletes, folder left for retry.
    expect(strom.media.deleteFile).not.toHaveBeenCalled();
    expect(strom.media.deleteDirectory).not.toHaveBeenCalled();
  });

  it('does not abort the sweep on a single transient per-file failure (#465)', async () => {
    // The first segment's PUT fails with a transient 500; the rest must still
    // be attempted (best-effort per-file semantics, not a short-circuit).
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/media/file/')) {
        return Promise.resolve({ ok: true, arrayBuffer: async () => new TextEncoder().encode('data').buffer });
      }
      if (url.includes('seg_00001')) {
        return Promise.resolve({ ok: false, status: 500, text: async () => 'InternalError' });
      }
      return Promise.resolve({ ok: true, text: async () => '' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const strom = makeStromMediaClient([
      { name: 'seg_00001.mp4', path: 'recordings/prod-rec-1/seg_00001.mp4', is_dir: false, size: 4 },
      { name: 'seg_00002.mp4', path: 'recordings/prod-rec-1/seg_00002.mp4', is_dir: false, size: 4 },
    ]);

    const { uploadRecordings } = await import('../lib/recording-uploader.js');
    const res = await uploadRecordings({
      strom: strom as never,
      stromUrl: 'http://localhost:7000',
      stromToken: 'tok',
      outputDir: 'recordings/prod-rec-1',
      productionId: 'prod-rec-1',
      target,
      isStillRecording: () => false,
    });

    // The transient failure did not short-circuit: both segments were attempted.
    expect(res.abortedOnAuthError).toBeUndefined();
    expect(res.failed.map((f) => f.file)).toEqual(['recordings/prod-rec-1/seg_00001.mp4']);
    expect(res.uploaded.map((u) => u.key)).toEqual(['prod-rec-1/seg_00002.mp4']);
    // The one segment that uploaded is deleted; the folder still holds the
    // failed one, so no directory cleanup.
    expect(strom.media.deleteFile).toHaveBeenCalledTimes(1);
    expect(strom.media.deleteFile).toHaveBeenCalledWith('recordings/prod-rec-1/seg_00002.mp4');
    expect(strom.media.deleteDirectory).not.toHaveBeenCalled();
  });
});

describe('recording-uploader — recordingStartFromFileName', () => {
  it('reads the session start from the timestamp Strom puts in a segment name', async () => {
    const { recordingStartFromFileName } = await import('../lib/recording-uploader.js');
    expect(recordingStartFromFileName('recording_20260110_090000_00000.mp4')).toBe('2026-01-10T09:00:00.000Z');
    expect(recordingStartFromFileName('my_show_20261231_235959_00042.mkv')).toBe('2026-12-31T23:59:59.000Z');
  });

  it('returns undefined for a name without a valid timestamp', async () => {
    const { recordingStartFromFileName } = await import('../lib/recording-uploader.js');
    expect(recordingStartFromFileName('seg_00001.mp4')).toBeUndefined();
    expect(recordingStartFromFileName('recording_20261301_090000_00000.mp4')).toBeUndefined();
    expect(recordingStartFromFileName('recording_20260230_090000_00000.mp4')).toBeUndefined();
  });
});

describe('recording-uploader — presignGetUrl (#42)', () => {
  const target = {
    endpoint: 'minio.example.com',
    useSsl: true,
    region: 'us-east-1',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'secretexamplekey',
    bucket: 'openlive-vod',
  };

  it('produces a path-style, SigV4-query-signed GET URL for the object', async () => {
    const { presignGetUrl } = await import('../lib/recording-uploader.js');
    const now = new Date('2026-09-16T10:00:00.000Z');
    const url = presignGetUrl(target, 'prod-1/seg_00001.mp4', 3600, now);

    expect(url.startsWith('https://minio.example.com/openlive-vod/prod-1/seg_00001.mp4?')).toBe(true);
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toContain('X-Amz-Date=20260916T100000Z');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    // Credential is scoped to the date/region/service.
    expect(url).toContain(encodeURIComponent('AKIAEXAMPLE/20260916/us-east-1/s3/aws4_request'));
  });

  it('is deterministic for a fixed clock and encodes key path segments', async () => {
    const { presignGetUrl } = await import('../lib/recording-uploader.js');
    const now = new Date('2026-09-16T10:00:00.000Z');
    const a = presignGetUrl(target, 'prod 1/seg 1.mp4', 600, now);
    const b = presignGetUrl(target, 'prod 1/seg 1.mp4', 600, now);
    expect(a).toBe(b);
    // Spaces in the key are percent-encoded per-segment (slash preserved).
    expect(a).toContain('/openlive-vod/prod%201/seg%201.mp4?');
  });
});
