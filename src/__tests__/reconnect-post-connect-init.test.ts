/**
 * Regression test for issue #581 (OL-33): on a fresh managed instance whose
 * first CouchDB connect failed (401), a later successful POST /api/v1/reconnect
 * restored the DB handle but never ran the post-connect init, so the
 * credential-key caches stayed empty and POST /api/v1/storage-connections kept
 * failing closed with a STORAGE_CONNECTION_KEY 503 until a restart.
 *
 * CouchDB, Strom and the WS controller are mocked. The key modules are REAL so
 * the test covers the actual bootstrap path; the once-only DB steps (fixtures,
 * migrations, reconcile, upload resume) are stubbed — they have their own tests.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_BEARER = 'test-secret-key';
process.env['API_KEY'] = TEST_BEARER;
// No env key overrides: the instance must rely on the backend-generated keys.
delete process.env['STORAGE_CONNECTION_KEY'];
delete process.env['SRT_PASSPHRASE_KEY'];
delete process.env['HTML_AUTH_KEY'];
delete process.env['RTMP_CREDENTIALS_KEY'];
delete process.env['GUEST_INVITE_SECRET'];

// ---------------------------------------------------------------------------
// Mock CouchDB: the first connect fails with a 401, later ones succeed.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({ connected: false, failNext: 0 }));

function memDb() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    get: async (id: string) => {
      const d = docs.get(id);
      if (!d) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return d;
    },
    insert: async (doc: Record<string, unknown>) => {
      if (docs.has(doc['_id'] as string)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
      docs.set(doc['_id'] as string, { ...doc, _rev: '1-x' });
      return { ok: true, id: doc['_id'], rev: '1-x' };
    },
    find: async () => ({ docs: [] }),
    findTrusted: async () => ({ docs: [] }),
    destroy: async () => ({ ok: true }),
  };
}

const dbs = vi.hoisted(() => ({} as Record<string, ReturnType<typeof memDb>>));

vi.mock('../db/index.js', () => {
  const handle = (name: string) => () => {
    if (!state.connected) throw new Error('db not connected');
    return (dbs[name] ??= memDb());
  };
  return {
    connectDb: vi.fn(async () => {
      if (state.failNext > 0) {
        state.failNext--;
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
      }
      state.connected = true;
    }),
    isDbConnected: vi.fn(() => state.connected),
    isDbReady: vi.fn(async () => state.connected),
    getDb: handle('productions'),
    getSourcesDb: handle('sources'),
    getOutputsDb: handle('outputs'),
    getRecordingsDb: handle('recordings'),
    getGatewaysDb: handle('gateways'),
    getStorageConnectionsDb: handle('storage'),
    getGuestSigningKeysDb: handle('guestKeys'),
    getCredentialEncryptionKeysDb: handle('credKeys'),
    getRtmpCredentialKeysDb: handle('rtmpKeys'),
  };
});

vi.mock('../db/seed.js', () => ({ cleanLegacyFixtures: vi.fn(async () => {}) }));
vi.mock('../services/migrate-audio-channel-order.js', () => ({ migrateAudioChannelOrder: vi.fn(async () => {}) }));
vi.mock('../services/migrate-recording-kind.js', () => ({ migrateRecordingKind: vi.fn(async () => {}) }));
vi.mock('../services/reconcile.js', () => ({ reconcileProductionStatuses: vi.fn(async () => {}) }));
vi.mock('../services/live-recording-upload.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/live-recording-upload.js')>();
  return { ...actual, resumeLiveRecordingUploads: vi.fn(async () => {}) };
});

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn().mockResolvedValue({ version: '1.0.0' }), iceServers: vi.fn() };
    flows = { get: vi.fn(), list: vi.fn().mockResolvedValue({ flows: [] }) };
    mixer = { multiviewEndpoint: vi.fn() };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------

const AUTH = { authorization: `Bearer ${TEST_BEARER}` };
const validCreate = {
  name: 'Customer West S3',
  endpoint: 'https://s3.eu-west-1.amazonaws.com',
  region: 'eu-west-1',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  role: 'clip',
};

let app: FastifyInstance;
let postConnect: typeof import('../lib/post-connect-init.js');
let credKey: typeof import('../lib/credential-encryption-key.js');
let rtmpKey: typeof import('../lib/rtmp-credential-key.js');
let guestKey: typeof import('../lib/guest-signing-key.js');
let crypto: typeof import('../lib/srt-passphrase-crypto.js');
let db: typeof import('../db/index.js');
const prevNodeEnv = process.env['NODE_ENV'];

beforeAll(async () => {
  postConnect = await import('../lib/post-connect-init.js');
  credKey = await import('../lib/credential-encryption-key.js');
  rtmpKey = await import('../lib/rtmp-credential-key.js');
  guestKey = await import('../lib/guest-signing-key.js');
  crypto = await import('../lib/srt-passphrase-crypto.js');
  db = await import('../db/index.js');
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  state.connected = false;
  state.failNext = 0;
  for (const k of Object.keys(dbs)) delete dbs[k];
  postConnect.__resetPostConnectInitForTests();
  credKey.__resetCredentialEncryptionKeyCacheForTests();
  rtmpKey.__resetRtmpCredentialKeyCacheForTests();
  guestKey.__resetGuestSigningKeyCacheForTests();
  crypto.resetKeyCache();
  vi.mocked(db.connectDb).mockClear();
  // Fail-closed path (no plaintext fallback) is production-only.
  process.env['NODE_ENV'] = 'production';
});

afterEach(() => {
  process.env['NODE_ENV'] = prevNodeEnv;
  postConnect.__resetPostConnectInitForTests();
});

describe('post-connect init after a failed startup connect (#581)', () => {
  it('/api/v1/reconnect runs the key bootstraps so storage connections can be saved', async () => {
    // Startup: the first connect fails with a 401.
    state.failNext = 1;
    await expect(postConnect.connectDbAndInit(app.log)).rejects.toMatchObject({ statusCode: 401 });
    expect(credKey.getStoredCredentialKey()).toBeNull();

    // What the old /reconnect did: connectDb() alone. The DB is back but no key
    // was bootstrapped, so the save fails closed — the reported symptom.
    await db.connectDb();
    const before = await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate });
    expect(before.statusCode).toBe(503);
    expect(before.body).toContain('STORAGE_CONNECTION_KEY');

    // Credentials fixed; operator hits reconnect.
    const rc = await app.inject({ method: 'POST', url: '/api/v1/reconnect', headers: AUTH });
    expect(rc.statusCode).toBe(200);
    expect(rc.json()).toMatchObject({ ok: true, db: true, strom: true });

    expect(credKey.getStoredCredentialKey()).toBeInstanceOf(Buffer);
    expect(rtmpKey.getStoredRtmpCredentialKey()).toBeInstanceOf(Buffer);
    expect(guestKey.isGuestSigningKeyAvailable()).toBe(true);

    const res = await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate });
    expect(res.statusCode).toBe(201);
    const stored = dbs['storage']!.docs.get(res.json().id)!;
    expect(String(stored['secretKeyEnc']).startsWith('encv1:')).toBe(true);
  });

  it('runs the key bootstraps on reconnect even when the DB handle is already connected', async () => {
    state.connected = true; // e.g. connected by a path that skipped init
    const rc = await app.inject({ method: 'POST', url: '/api/v1/reconnect', headers: AUTH });
    expect(rc.statusCode).toBe(200);
    expect(credKey.getStoredCredentialKey()).toBeInstanceOf(Buffer);
    expect(db.connectDb).not.toHaveBeenCalled();
    const res = await app.inject({ method: 'POST', url: '/api/v1/storage-connections', headers: AUTH, payload: validCreate });
    expect(res.statusCode).toBe(201);
  });

  it('shares one in-flight run across concurrent calls', async () => {
    await Promise.all([
      postConnect.connectDbAndInit(app.log),
      postConnect.connectDbAndInit(app.log),
      app.inject({ method: 'POST', url: '/api/v1/reconnect', headers: AUTH }),
    ]);
    expect(db.connectDb).toHaveBeenCalledTimes(1);
  });

  it('keeps env overrides winning: no stored key is generated when RTMP_CREDENTIALS_KEY is set', async () => {
    process.env['RTMP_CREDENTIALS_KEY'] = Buffer.alloc(32, 7).toString('base64');
    try {
      await postConnect.connectDbAndInit(app.log);
      expect(rtmpKey.getStoredRtmpCredentialKey()).toBeNull();
      expect(dbs['rtmpKeys']?.docs.size ?? 0).toBe(0);
    } finally {
      delete process.env['RTMP_CREDENTIALS_KEY'];
    }
  });

  it('background retry connects and runs init once the DB becomes reachable', async () => {
    vi.useFakeTimers();
    try {
      state.failNext = 2;
      await expect(postConnect.connectDbAndInit(app.log)).rejects.toMatchObject({ statusCode: 401 });
      postConnect.startDbConnectRetry(app.log);
      await vi.advanceTimersByTimeAsync(5_000); // attempt 2: still 401
      expect(state.connected).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000); // attempt 3: succeeds
      expect(state.connected).toBe(true);
      expect(credKey.getStoredCredentialKey()).toBeInstanceOf(Buffer);
      expect(db.connectDb).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
