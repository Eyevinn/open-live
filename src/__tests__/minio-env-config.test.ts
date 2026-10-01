/**
 * Tests for how the MinIO / S3 recording vars are read from the environment.
 *
 * Empty (`MINIO_ENDPOINT=`, as docker-compose writes it) and whitespace-only
 * values must read as unset: an empty `MINIO_ENDPOINT` must not hide a set
 * `S3_ENDPOINT`, and `" "` must not count as configured (the upload would only
 * fail later, at deactivate). The recording gate and the uploader target must
 * agree on every env shape.
 *
 * `config.ts` reads the environment once at module load, so each case sets the
 * env and imports the modules fresh via `vi.resetModules()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const KEYS = [
  'MINIO_ENDPOINT',
  'S3_ENDPOINT',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'MINIO_BUCKET',
  'MINIO_REGION',
];
const FULL = { MINIO_ACCESS_KEY: 'a', MINIO_SECRET_KEY: 's', MINIO_BUCKET: 'b' };

async function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  const cfg = await import('../config.js');
  const uploader = await import('../lib/recording-uploader.js');
  return { ...cfg, minioTargetFromConfig: uploader.minioTargetFromConfig };
}

describe('MinIO env resolution', () => {
  beforeEach(() => {
    // config.ts calls buildCouchdbUrl() at import, which requires COUCHDB_URL.
    process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it('S3_ENDPOINT alone with the other three set enables recording', async () => {
    const m = await load({ S3_ENDPOINT: 'http://h:9000', ...FULL });
    expect(m.isObjectStorageConfigured()).toBe(true);
    expect(m.minioTargetFromConfig()?.endpoint).toBe('h:9000');
  });

  it('an empty MINIO_ENDPOINT does not hide a set S3_ENDPOINT', async () => {
    const m = await load({ MINIO_ENDPOINT: '', S3_ENDPOINT: 'http://h:9000', ...FULL });
    expect(m.config.minioEndpoint).toBe('http://h:9000');
    expect(m.isObjectStorageConfigured()).toBe(true);
  });

  it('compose-style empty vars everywhere leave recording off', async () => {
    const m = await load({
      MINIO_ENDPOINT: '',
      MINIO_ACCESS_KEY: '',
      MINIO_SECRET_KEY: '',
      MINIO_BUCKET: '',
    });
    expect(m.isObjectStorageConfigured()).toBe(false);
    expect(m.minioTargetFromConfig()).toBeNull();
  });

  it.each(['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET'])(
    'a whitespace-only %s does not count as configured',
    async (name) => {
      const m = await load({ MINIO_ENDPOINT: 'http://h:9000', ...FULL, [name]: '  \t' });
      expect(m.isObjectStorageConfigured()).toBe(false);
      expect(m.minioTargetFromConfig()).toBeNull();
    },
  );

  it('trims surrounding whitespace from set values', async () => {
    const m = await load({
      MINIO_ENDPOINT: ' https://h:9000 ',
      MINIO_ACCESS_KEY: ' a ',
      MINIO_SECRET_KEY: 's\n',
      MINIO_BUCKET: ' b',
    });
    expect(m.minioTargetFromConfig()).toMatchObject({
      endpoint: 'h:9000',
      useSsl: true,
      accessKey: 'a',
      secretKey: 's',
      bucket: 'b',
    });
  });

  it('a whitespace-only MINIO_REGION falls back to us-east-1', async () => {
    const m = await load({ MINIO_ENDPOINT: 'http://h:9000', ...FULL, MINIO_REGION: ' ' });
    expect(m.config.minioRegion).toBe('us-east-1');
  });

  it('the recording gate and the uploader target agree for every subset of the four vars', async () => {
    const names = ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY', 'MINIO_BUCKET'];
    for (let mask = 0; mask < 16; mask++) {
      for (const k of KEYS) delete process.env[k];
      const env: Record<string, string> = {};
      names.forEach((n, i) => {
        env[n] = mask & (1 << i) ? (n === 'MINIO_ENDPOINT' ? 'http://h:9000' : 'v') : ' ';
      });
      const m = await load(env);
      expect(m.isObjectStorageConfigured()).toBe(mask === 15);
      expect(m.minioTargetFromConfig() !== null).toBe(mask === 15);
    }
  });
});
