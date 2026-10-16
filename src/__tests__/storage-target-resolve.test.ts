/**
 * resolveStorageTarget — the single resolver used by the clip, recording-upload,
 * and recording-playback paths (issue #520, OL-21, spec §3.2).
 *
 * Covers the default-connection fallback (absent / "default" → env target,
 * byte-for-byte today's behaviour), per-connection resolution with the secret
 * decrypted, and the not-found error for a dangling connectionId.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { StorageConnectionDoc } from '../db/types.js';

process.env['STORAGE_CONNECTION_KEY'] = Buffer.alloc(32, 5).toString('base64');
process.env['MINIO_ENDPOINT'] = 'https://minio.example.com';
process.env['MINIO_ACCESS_KEY'] = 'AKIADEFAULT';
process.env['MINIO_SECRET_KEY'] = 'defaultsecret';
process.env['MINIO_BUCKET'] = 'default-bucket';
process.env['MINIO_REGION'] = 'eu-north-1';

const store = new Map<string, StorageConnectionDoc>();
vi.mock('../db/index.js', () => ({
  getStorageConnectionsDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = store.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return doc;
    }),
  }),
}));

const { resolveStorageTarget, StorageConnectionNotFoundError } = await import('../lib/storage-connection.js');
const { encryptStorageSecret } = await import('../lib/storage-connection-crypto.js');

beforeEach(() => store.clear());
afterAll(() => {
  delete process.env['STORAGE_CONNECTION_KEY'];
});

describe('resolveStorageTarget', () => {
  it('falls back to the env default connection when no connectionId is given', async () => {
    const target = await resolveStorageTarget(undefined, 'clip-bucket');
    expect(target).toMatchObject({
      endpoint: 'minio.example.com',
      useSsl: true,
      region: 'eu-north-1',
      accessKey: 'AKIADEFAULT',
      secretKey: 'defaultsecret',
      bucket: 'clip-bucket',
    });
  });

  it('treats the reserved id "default" identically to absent', async () => {
    const target = await resolveStorageTarget('default');
    expect(target?.bucket).toBe('default-bucket'); // MINIO_BUCKET
    expect(target?.endpoint).toBe('minio.example.com');
  });

  it('resolves a real connection, decrypting its secret, bucket from the ref override', async () => {
    store.set('stconn-1', {
      _id: 'stconn-1', type: 'storage-connection', name: 'c', endpoint: 's3.customer.com',
      useSsl: true, region: 'eu-west-1', accessKey: 'AKCUST',
      secretKeyEnc: encryptStorageSecret('customersecret'), defaultBucket: 'conn-default',
      role: 'clip', createdAt: 'x', updatedAt: 'x',
    });
    const target = await resolveStorageTarget('stconn-1', 'override-bucket');
    expect(target).toMatchObject({ endpoint: 's3.customer.com', accessKey: 'AKCUST', secretKey: 'customersecret', bucket: 'override-bucket' });
  });

  it('uses the connection defaultBucket when no override is given', async () => {
    store.set('stconn-2', {
      _id: 'stconn-2', type: 'storage-connection', name: 'c', endpoint: 's3.customer.com',
      useSsl: false, region: 'us-east-1', accessKey: 'AK',
      secretKeyEnc: encryptStorageSecret('s'), defaultBucket: 'conn-default', role: 'recording', createdAt: 'x', updatedAt: 'x',
    });
    const target = await resolveStorageTarget('stconn-2');
    expect(target?.bucket).toBe('conn-default');
  });

  it('throws StorageConnectionNotFoundError for a dangling connectionId', async () => {
    await expect(resolveStorageTarget('stconn-missing', 'b')).rejects.toBeInstanceOf(StorageConnectionNotFoundError);
  });
});
