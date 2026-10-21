/**
 * Streamed recording upload (issue #552): the Strom media download is piped
 * into the S3 upload one part at a time instead of being buffered whole, and
 * the MP4 duration is read from the `moov` box as the bytes stream past.
 *
 * Strom and S3 are mocked via a stubbed global fetch; the Strom download is a
 * real pull-based ReadableStream so the test can see how far ahead of the
 * upload the uploader reads.
 */
import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MULTIPART_PART_SIZE,
  uploadRecordings,
  uploadStream,
  type MinioTarget,
} from '../lib/recording-uploader.js';
import { Mp4DurationScanner, mp4DurationMs } from '../lib/mp4-duration.js';

const target: MinioTarget = {
  endpoint: 'silo.example:9000',
  useSsl: false,
  region: 'us-east-1',
  accessKey: 'AK',
  secretKey: 'SK',
  bucket: 'recs',
};

const MiB = 1024 * 1024;

afterEach(() => vi.unstubAllGlobals());

// ── MP4 fixture helpers (hand-built boxes, as in mp4-duration.test.ts) ──────

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box('mvhd', p);
}

const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomiso2avc1mp41', 'latin1'));
const moov = (timescale: number, duration: number) =>
  box('moov', mvhdV0(timescale, duration), box('trak', Buffer.alloc(64)));

// ── Mocks ───────────────────────────────────────────────────────────────────

/** Strom download body: `total` bytes, produced lazily in `chunkSize` chunks. */
function stromStream(opts: {
  total: number;
  chunkSize: number;
  byteAt?: (i: number) => number;
  data?: Buffer;
  failAfter?: number;
}) {
  const stats = { produced: 0, cancelled: false, hash: createHash('sha256') };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && stats.produced >= opts.failAfter) {
        controller.error(new Error('strom connection reset'));
        return;
      }
      if (stats.produced >= opts.total) {
        controller.close();
        return;
      }
      const n = Math.min(opts.chunkSize, opts.total - stats.produced);
      let chunk: Buffer;
      if (opts.data) {
        chunk = Buffer.from(opts.data.subarray(stats.produced, stats.produced + n));
      } else {
        chunk = Buffer.allocUnsafe(n);
        for (let i = 0; i < n; i++) chunk[i] = opts.byteAt!(stats.produced + i);
      }
      stats.hash.update(chunk);
      stats.produced += n;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

function s3res(status: number, body = '', headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, headers: new Headers(headers) };
}

interface S3Call {
  method: string;
  url: URL;
  size: number;
  /** Bytes read from Strom but not yet sent in an earlier part, at send time. */
  outstanding: number;
}

function stubFetch(opts: {
  download: () => ReadableStream<Uint8Array>;
  produced: () => number;
  failPart?: number;
}) {
  const calls: S3Call[] = [];
  const uploadedHash = createHash('sha256');
  let uploaded = 0;
  const fetchMock = vi.fn().mockImplementation(async (rawUrl: string, init: { method?: string; body?: Uint8Array } = {}) => {
    const url = new URL(rawUrl);
    if (url.pathname.startsWith('/api/media/file/')) return new Response(opts.download());
    const method = init.method ?? 'GET';
    const size = init.body?.length ?? 0;
    calls.push({ method, url, size, outstanding: opts.produced() - uploaded });
    if (method === 'POST' && url.searchParams.has('uploads')) {
      return s3res(200, '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
    }
    if (method === 'PUT') {
      const n = Number(url.searchParams.get('partNumber') ?? 0);
      if (n && n === opts.failPart) return s3res(500, 'boom');
      uploadedHash.update(init.body!);
      uploaded += size;
      return s3res(200, '', { ETag: `"etag-${n}"` });
    }
    if (method === 'POST') return s3res(200, '<CompleteMultipartUploadResult/>');
    if (method === 'DELETE') return s3res(204);
    return s3res(200);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, uploadedHash, uploadedBytes: () => uploaded };
}

function stromClient(name: string, size: number) {
  return {
    media: {
      list: vi.fn().mockResolvedValue({
        entries: [{ name, path: `recordings/prod-1/${name}`, is_dir: false, size }],
      }),
      deleteFile: vi.fn().mockResolvedValue({ success: true }),
      deleteDirectory: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function runUpload(strom: ReturnType<typeof stromClient>) {
  return uploadRecordings({
    strom: strom as never,
    stromUrl: 'http://strom:7000',
    stromToken: 'tok',
    outputDir: 'recordings/prod-1',
    productionId: 'prod-1',
    target,
    isStillRecording: () => false,
  });
}

/** Uploads an in-memory fixture through uploadRecordings, streamed in `chunkSize` chunks. */
async function uploadFixture(name: string, data: Buffer, chunkSize: number) {
  let stats = { produced: 0 };
  const mock = stubFetch({
    download: () => {
      const s = stromStream({ total: data.length, chunkSize, data });
      stats = s.stats;
      return s.stream;
    },
    produced: () => stats.produced,
  });
  const result = await runUpload(stromClient(name, data.length));
  return { result, ...mock };
}

// ── 1. Multipart upload without buffering the whole file ────────────────────

describe('streamed multipart upload (issue #552)', () => {
  it('uploads a file larger than 3 parts in ≤16 MiB parts without ever buffering it whole', async () => {
    const total = 3 * MULTIPART_PART_SIZE + 5 * MiB + 123; // > 3 parts
    const chunkSize = MiB;
    let src!: ReturnType<typeof stromStream>;
    const mock = stubFetch({
      download: () => {
        src = stromStream({ total, chunkSize, byteAt: (i) => (i * 31 + 7) & 0xff });
        return src.stream;
      },
      produced: () => src.stats.produced,
    });
    const strom = stromClient('seg_00001.mp4', total);

    const result = await runUpload(strom);

    expect(result.failed).toEqual([]);
    expect(result.uploaded).toHaveLength(1);
    expect(result.uploaded[0]!.sizeBytes).toBe(total);

    const create = mock.calls[0]!;
    expect(create.method).toBe('POST');
    expect(create.url.searchParams.has('uploads')).toBe(true);

    const parts = mock.calls.filter((c) => c.method === 'PUT');
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.url.searchParams.get('partNumber'))).toEqual(['1', '2', '3', '4']);
    expect(parts.every((p) => p.size <= MULTIPART_PART_SIZE)).toBe(true);
    expect(parts.slice(0, 3).every((p) => p.size === MULTIPART_PART_SIZE)).toBe(true);
    expect(parts.reduce((n, p) => n + p.size, 0)).toBe(total);

    // The core guarantee: when each part is sent, the uploader has read at most
    // that part plus a small read-ahead from Strom — never the whole file.
    const maxOutstanding = Math.max(...parts.map((p) => p.outstanding));
    expect(maxOutstanding).toBeLessThanOrEqual(MULTIPART_PART_SIZE + 2 * chunkSize);
    expect(maxOutstanding).toBeLessThan(total / 2);

    // Bytes arrive intact and in order.
    expect(mock.uploadedHash.digest('hex')).toBe(src.stats.hash.digest('hex'));
    expect(mock.calls[mock.calls.length - 1]!.method).toBe('POST'); // Complete
    expect(mock.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(strom.media.deleteFile).toHaveBeenCalledWith('recordings/prod-1/seg_00001.mp4');
  });

  it('keeps a single PutObject for a file at or under one part', async () => {
    for (const total of [0, 5, 10]) {
      const calls: Array<{ method: string; url: string; size: number }> = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { method: string; body?: Uint8Array }) => {
        calls.push({ method: init.method, url, size: init.body?.length ?? 0 });
        return s3res(200);
      }));
      async function* src() {
        for (let i = 0; i < total; i += 3) yield Buffer.alloc(Math.min(3, total - i), 1);
      }
      expect(await uploadStream(target, 'k', src(), 'video/mp4', 10)).toBe(total);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('PUT');
      expect(new URL(calls[0]!.url).search).toBe('');
      expect(calls[0]!.size).toBe(total);
    }
  });

  it('switches to multipart as soon as the stream runs one byte past a part', async () => {
    const calls: Array<{ method: string; size: number }> = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, init: { method: string; body?: Uint8Array }) => {
      calls.push({ method: init.method, size: init.body?.length ?? 0 });
      if (init.method === 'POST' && url.includes('uploads')) return s3res(200, '<UploadId>u</UploadId>');
      return s3res(200, '', { ETag: '"e"' });
    }));
    async function* src() {
      yield Buffer.alloc(4);
      yield Buffer.alloc(0);
      yield Buffer.alloc(7);
    }
    expect(await uploadStream(target, 'k', src(), 'video/mp4', 10)).toBe(11);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.size)).toEqual([10, 1]);
  });
});

// ── 2. Duration from the stream ─────────────────────────────────────────────

describe('streamed MP4 duration (issue #552)', () => {
  it('reads durationMs when moov is at the start of the file', async () => {
    const data = Buffer.concat([ftyp, moov(1000, 61_234), box('mdat', Buffer.alloc(4096, 9))]);
    const { result } = await uploadFixture('seg_00001.mp4', data, 7);
    expect(result.uploaded[0]!.durationMs).toBe(61_234);
  });

  it('reads durationMs when moov is at the end, after a multi-part mdat', async () => {
    const data = Buffer.concat([ftyp, box('mdat', Buffer.alloc(MULTIPART_PART_SIZE + 3 * MiB, 9)), moov(90_000, 90_000 * 125)]);
    const { result, calls } = await uploadFixture('seg_00001.mp4', data, 64 * 1024 + 3);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2); // went multipart
    expect(result.uploaded[0]!.durationMs).toBe(125_000);
    expect(result.uploaded[0]!.sizeBytes).toBe(data.length);
  });

  it('omits durationMs when the file has no moov', async () => {
    const data = Buffer.concat([ftyp, box('mdat', Buffer.alloc(2048, 9))]);
    const { result } = await uploadFixture('seg_00001.mp4', data, 7);
    expect(result.uploaded).toHaveLength(1);
    expect(result.uploaded[0]).not.toHaveProperty('durationMs');
  });

  it('does not parse a non-MP4 file', async () => {
    const data = Buffer.concat([ftyp, moov(1000, 5_000)]);
    const { result } = await uploadFixture('seg_00001.ts', data, 7);
    expect(result.uploaded[0]).not.toHaveProperty('durationMs');
  });

  describe('Mp4DurationScanner', () => {
    function scan(data: Buffer, chunkSize: number, maxMoov?: number) {
      const s = new Mp4DurationScanner(maxMoov);
      for (let i = 0; i < data.length; i += chunkSize) s.push(data.subarray(i, i + chunkSize));
      return s.finish();
    }

    it('matches mp4DurationMs on the whole file at every chunking, including byte-by-byte', () => {
      const files = [
        Buffer.concat([ftyp, moov(1000, 61_234), box('mdat', Buffer.alloc(300))]),
        Buffer.concat([ftyp, box('free', Buffer.alloc(13)), box('mdat', Buffer.alloc(300)), moov(600, 600 * 42)]),
      ];
      for (const file of files) {
        for (const chunk of [1, 2, 7, 8, 9, 16, 1000]) {
          expect(scan(file, chunk)).toBe(mp4DurationMs(file));
        }
      }
    });

    it('skips a 64-bit largesize box before moov', () => {
      const payload = Buffer.alloc(40);
      const header = Buffer.alloc(16);
      header.writeUInt32BE(1, 0);
      header.write('mdat', 4, 'latin1');
      header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
      const file = Buffer.concat([ftyp, header, payload, moov(1000, 5_000)]);
      expect(scan(file, 3)).toBe(5_000);
    });

    it('returns undefined rather than a guess', () => {
      // moov larger than the retention cap
      expect(scan(Buffer.concat([ftyp, moov(1000, 5_000)]), 5, 64)).toBeUndefined();
      // stream ends inside moov
      expect(scan(Buffer.concat([ftyp, moov(1000, 5_000)]).subarray(0, 60), 5)).toBeUndefined();
      // mdat of size 0 runs to end of file — nothing after it is a box
      const open = Buffer.from([0, 0, 0, 0, 0x6d, 0x64, 0x61, 0x74]);
      expect(scan(Buffer.concat([ftyp, open, moov(1000, 5_000)]), 5)).toBeUndefined();
      // garbage
      expect(scan(Buffer.from('not an mp4 file at all'), 4)).toBeUndefined();
      expect(scan(Buffer.alloc(0), 4)).toBeUndefined();
    });
  });
});

// ── 3. Failure handling ─────────────────────────────────────────────────────

describe('streamed upload failures (issue #552)', () => {
  it('aborts the multipart upload on a failed part, keeps the Strom file, and reports the failure', async () => {
    const total = 3 * MULTIPART_PART_SIZE;
    let src!: ReturnType<typeof stromStream>;
    const mock = stubFetch({
      download: () => {
        src = stromStream({ total, chunkSize: MiB, byteAt: () => 1 });
        return src.stream;
      },
      produced: () => src.stats.produced,
      failPart: 2,
    });
    const strom = stromClient('seg_00001.mp4', total);

    const result = await runUpload(strom);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toEqual([
      { file: 'recordings/prod-1/seg_00001.mp4', error: 'S3 UploadPart 2 of prod-1/seg_00001.mp4 failed: 500 boom' },
    ]);
    const abort = mock.calls.find((c) => c.method === 'DELETE');
    expect(abort?.url.searchParams.get('uploadId')).toBe('up-1');
    expect(mock.calls.filter((c) => c.method === 'PUT')).toHaveLength(2); // part 3 never sent
    expect(strom.media.deleteFile).not.toHaveBeenCalled();
    expect(strom.media.deleteDirectory).not.toHaveBeenCalled();
    // The rest of the download was abandoned, not read to the end.
    expect(src.stats.cancelled).toBe(true);
    expect(src.stats.produced).toBeLessThan(total);
  });

  it('aborts the multipart upload when the Strom download dies mid-stream', async () => {
    let src!: ReturnType<typeof stromStream>;
    const mock = stubFetch({
      download: () => {
        src = stromStream({ total: 3 * MULTIPART_PART_SIZE, chunkSize: MiB, byteAt: () => 1, failAfter: MULTIPART_PART_SIZE + 2 * MiB });
        return src.stream;
      },
      produced: () => src.stats.produced,
    });
    const strom = stromClient('seg_00001.mp4', 3 * MULTIPART_PART_SIZE);

    const result = await runUpload(strom);

    expect(result.uploaded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/strom connection reset/);
    expect(mock.calls.some((c) => c.method === 'DELETE' && c.url.searchParams.get('uploadId') === 'up-1')).toBe(true);
    expect(mock.calls.some((c) => c.method === 'POST' && !c.url.searchParams.has('uploads'))).toBe(false); // never completed
    expect(strom.media.deleteFile).not.toHaveBeenCalled();
  });
});
