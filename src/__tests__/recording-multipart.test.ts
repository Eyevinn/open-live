import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  putObjectMultipart,
  uploadObject,
  S3AuthError,
  type MinioTarget,
} from '../lib/recording-uploader.js';

const target: MinioTarget = {
  endpoint: 'silo.example:9000',
  useSsl: false,
  region: 'us-east-1',
  accessKey: 'AK',
  secretKey: 'SK',
  bucket: 'recs',
};

function res(status: number, body = '', headers: Record<string, string> = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, headers: new Headers(headers) };
}

type Call = { method: string; url: string; body?: Uint8Array };

function mockS3(opts: { failPart?: number; completeBody?: string } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn().mockImplementation(async (url: string, init: { method: string; body?: Uint8Array }) => {
    calls.push({ method: init.method, url, body: init.body });
    const u = new URL(url);
    if (init.method === 'POST' && u.searchParams.has('uploads')) {
      return res(200, '<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
    }
    if (init.method === 'PUT' && u.searchParams.has('partNumber')) {
      const n = Number(u.searchParams.get('partNumber'));
      if (n === opts.failPart) return res(500, 'boom');
      return res(200, '', { ETag: `"etag-${n}"` });
    }
    if (init.method === 'POST') return res(200, opts.completeBody ?? '<CompleteMultipartUploadResult/>');
    if (init.method === 'DELETE') return res(204);
    return res(200);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('multipart recording upload (issue #548)', () => {
  it('splits the body into parts and completes with ordered ETags', async () => {
    const calls = mockS3();
    await putObjectMultipart(target, 'p/seg.mp4', Buffer.alloc(25, 1), 'video/mp4', 10);

    const parts = calls.filter((c) => c.method === 'PUT');
    expect(parts.map((p) => p.body!.length)).toEqual([10, 10, 5]);
    expect(parts.map((p) => new URL(p.url).searchParams.get('partNumber'))).toEqual(['1', '2', '3']);
    expect(parts.every((p) => new URL(p.url).searchParams.get('uploadId') === 'up-1')).toBe(true);

    const complete = calls[calls.length - 1]!;
    expect(complete.method).toBe('POST');
    expect(new URL(complete.url).searchParams.get('uploadId')).toBe('up-1');
    const xml = Buffer.from(complete.body!).toString();
    expect(xml).toContain('<Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part>');
    expect(xml).toContain('<Part><PartNumber>3</PartNumber><ETag>"etag-3"</ETag></Part>');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('aborts the multipart upload and rethrows when a part fails', async () => {
    const calls = mockS3({ failPart: 2 });
    await expect(putObjectMultipart(target, 'p/seg.mp4', Buffer.alloc(25), 'video/mp4', 10)).rejects.toThrow(/UploadPart 2.*500/);

    const abort = calls.find((c) => c.method === 'DELETE');
    expect(abort).toBeDefined();
    expect(new URL(abort!.url).searchParams.get('uploadId')).toBe('up-1');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2); // part 3 never sent
    expect(calls.some((c) => c.method === 'POST' && !new URL(c.url).searchParams.has('uploads'))).toBe(false);
  });

  it('aborts when CompleteMultipartUpload answers 200 with an <Error> body', async () => {
    const calls = mockS3({ completeBody: '<Error><Code>InternalError</Code></Error>' });
    await expect(putObjectMultipart(target, 'k', Buffer.alloc(15), 'video/mp4', 10)).rejects.toThrow(/CompleteMultipartUpload/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('surfaces an auth rejection on a part as S3AuthError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_u: string, init: { method: string }) => {
      if (init.method === 'POST') return res(200, '<UploadId>u</UploadId>');
      if (init.method === 'DELETE') return res(204);
      return res(403, '<Error><Code>AccessDenied</Code></Error>');
    }));
    await expect(putObjectMultipart(target, 'k', Buffer.alloc(15), 'video/mp4', 10)).rejects.toBeInstanceOf(S3AuthError);
  });

  it('fails without a part upload when CreateMultipartUpload returns no UploadId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(200, '<Nothing/>'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(putObjectMultipart(target, 'k', Buffer.alloc(15), 'video/mp4', 10)).rejects.toThrow(/no UploadId/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('uses a single PutObject for a file that fits in one part', async () => {
    const calls = mockS3();
    await uploadObject(target, 'p/small.mp4', Buffer.alloc(10), 'video/mp4', 10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PUT');
    expect(new URL(calls[0]!.url).search).toBe('');
  });

  it('uses multipart for a file larger than one part', async () => {
    const calls = mockS3();
    await uploadObject(target, 'p/big.mp4', Buffer.alloc(11), 'video/mp4', 10);
    expect(calls[0]!.method).toBe('POST');
    expect(new URL(calls[0]!.url).search).toBe('?uploads=');
  });
});
