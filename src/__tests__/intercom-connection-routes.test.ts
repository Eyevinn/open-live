/**
 * `/api/v1/intercom-connection` routes (issue #617, OL-47,
 * `docs/specs/intercom-connection.md`). CouchDB, the OSC token service and the
 * intercom manager (fetch) are mocked — no live services.
 *
 * Covers: the API_KEY gate; status `source` in each of none / env / stored /
 * both; set (URL normalisation, mode inference, osc vs direct inputs,
 * write-only secrets stored as ciphertext, secret carry-over only for the same
 * origin); clear (falls back to env); SSRF refusal naming the allowlist; the
 * test probe's outcomes (ok, unreachable, wrong key, SAT exchange failure,
 * redirect) for unsaved and effective connections, with `redirect: 'manual'`
 * and never `GET /productionlist`; and that no response or captured log line
 * (any level) contains a secret.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { IntercomConnectionDoc } from '../db/types.js';

const CREW_BEARER = 'test-api-key-617';
process.env['API_KEY'] = CREW_BEARER;
process.env['LOG_LEVEL'] = 'trace';
process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 9).toString('base64');
delete process.env['INTERCOM_MANAGER_URL'];
delete process.env['INTERCOM_MANAGER_TOKEN'];
delete process.env['OSC_PAT'];
delete process.env['OSC_ACCESS_TOKEN'];

// Secrets that must never surface in a response or a log line.
const API_KEY_SECRET = 'mgr-api-key-SECRET-1';
const WHIP_SECRET = 'mgr-whip-key-SECRET-2';
const PAT_SECRET = 'osc-pat-SECRET-3';
const ENV_TOKEN_SECRET = 'env-token-SECRET-4';
const SAT = 'sat-SECRET-5';
const SECRETS = [API_KEY_SECRET, WHIP_SECRET, PAT_SECRET, ENV_TOKEN_SECRET, SAT];

const store = new Map<string, IntercomConnectionDoc>();
const intercomDb = {
  get: vi.fn(async (id: string) => {
    const doc = store.get(id);
    if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
    return doc;
  }),
  insert: vi.fn(async (doc: IntercomConnectionDoc) => {
    store.set(doc._id, { ...doc, _rev: '1-x' });
    return { ok: true, id: doc._id, rev: '1-x' };
  }),
  destroy: vi.fn(async (id: string) => {
    store.delete(id);
    return { ok: true };
  }),
};

vi.mock('../db/index.js', () => ({
  getIntercomConnectionDb: () => intercomDb,
  getDb: () => ({ get: vi.fn(), find: vi.fn(), findTrusted: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {}, clearAudioState: vi.fn(), clearPipState: vi.fn(), clearFxState: vi.fn(),
}));

const AUTH = { authorization: `Bearer ${CREW_BEARER}` };
const OSC_URL = 'https://acme-ic.eyevinn-intercom-manager.auto.prod.osaas.io';
const DIRECT_URL = 'https://intercom.example.com';
const TOKEN_URL = 'https://token.svc.prod.osaas.io/servicetoken';

let app: FastifyInstance;
const logLines: string[] = [];
const responses: string[] = [];
let config: typeof import('../config.js')['config'];
let mutable: Record<string, unknown>;

interface Call { url: string; method: string; auth?: string; redirect?: string }
let calls: Call[] = [];

type ManagerBehaviour = 'ok' | 'unauthorized' | 'unreachable' | 'redirect' | 'html';
let manager: ManagerBehaviour = 'ok';
let tokenService: 'ok' | 'refuse' = 'ok';

function installFetch() {
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({
      url: u,
      method: (init?.method ?? 'GET').toUpperCase(),
      auth: headers.get('authorization') ?? undefined,
      redirect: init?.redirect,
    });
    if (u === TOKEN_URL) {
      if (tokenService === 'refuse') {
        return new Response('{"reason":"invalid PAT"}', { status: 401, statusText: 'Unauthorized' });
      }
      return new Response(JSON.stringify({ token: SAT, expiry: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
    }
    if (manager === 'unreachable') throw new TypeError('fetch failed');
    if (manager === 'redirect') {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } });
    }
    if (manager === 'unauthorized') return new Response('{"error":"Unauthorized"}', { status: 401 });
    if (manager === 'html') return new Response('<html>not found</html>', { status: 404 });
    const m = /\/production\/(\d+)$/.exec(u);
    return new Response(JSON.stringify({ message: `Production with id ${m?.[1]} not found` }), { status: 404 });
  });
}

async function call(method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: AUTH, ...(payload !== undefined ? { payload: payload as object } : {}) });
  responses.push(res.body);
  return res;
}

beforeAll(async () => {
  ({ config } = await import('../config.js'));
  mutable = config as unknown as Record<string, unknown>;
  const { buildServer } = await import('../server.js');
  app = await buildServer({ logStream: { write: (line: string) => void logLines.push(line) } });
});

beforeEach(() => {
  store.clear();
  vi.restoreAllMocks();
  manager = 'ok';
  tokenService = 'ok';
  mutable['intercomManagerUrl'] = undefined;
  mutable['intercomManagerToken'] = undefined;
  mutable['intercomManagerAuthMode'] = 'direct';
  mutable['intercomWhipAuthKey'] = undefined;
  mutable['oscPat'] = PAT_SECRET;
  mutable['trustedIntercomHosts'] = [];
  installFetch();
});

afterAll(() => {
  // AC5: no secret in any response body or log line, at any level.
  expect(logLines.length).toBeGreaterThan(0);
  for (const text of [...responses, ...logLines]) {
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  }
});

describe('API_KEY gate', () => {
  it.each([
    ['GET', '/api/v1/intercom-connection'],
    ['PUT', '/api/v1/intercom-connection'],
    ['DELETE', '/api/v1/intercom-connection'],
    ['POST', '/api/v1/intercom-connection/test'],
  ] as const)('%s %s → 401 without the key', async (method, url) => {
    const res = await app.inject({ method, url, payload: method === 'PUT' ? { url: OSC_URL } : undefined });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET status — source', () => {
  it('neither: none, not configured', async () => {
    mutable['oscPat'] = undefined;
    const res = await call('GET', '/api/v1/intercom-connection');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'none', configured: false, url: null, mode: null, oscPatSet: false });
  });

  it('env only', async () => {
    mutable['intercomManagerUrl'] = 'https://env.example.com/api/v1';
    mutable['intercomManagerToken'] = ENV_TOKEN_SECRET;
    const res = await call('GET', '/api/v1/intercom-connection');
    expect(res.json()).toMatchObject({ source: 'env', configured: true, url: 'https://env.example.com/api/v1', mode: 'direct', tokenSet: true });
  });

  it('stored only, then both (stored wins), then cleared (env again)', async () => {
    expect((await call('PUT', '/api/v1/intercom-connection', { url: OSC_URL })).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/intercom-connection')).json()).toMatchObject({ source: 'stored', mode: 'osc' });

    mutable['intercomManagerUrl'] = 'https://env.example.com/api/v1';
    mutable['intercomManagerToken'] = ENV_TOKEN_SECRET;
    expect((await call('GET', '/api/v1/intercom-connection')).json()).toMatchObject({
      source: 'stored',
      url: `${OSC_URL}/api/v1`,
    });

    expect((await call('DELETE', '/api/v1/intercom-connection')).statusCode).toBe(204);
    expect((await call('GET', '/api/v1/intercom-connection')).json()).toMatchObject({
      source: 'env',
      url: 'https://env.example.com/api/v1',
    });
  });
});

describe('PUT', () => {
  it('OSC URL alone (with or without /api/v1): mode osc inferred, PAT source OscAccessToken', async () => {
    for (const url of [OSC_URL, `${OSC_URL}/api/v1/`]) {
      const res = await call('PUT', '/api/v1/intercom-connection', { url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        source: 'stored',
        configured: true,
        url: `${OSC_URL}/api/v1`,
        mode: 'osc',
        modeOverridden: false,
        patSource: 'OscAccessToken',
        oscPatSet: true,
        tokenSet: false,
        whipKeySet: false,
      });
    }
  });

  it('osc with no oscPat is stored but reported as not configured, plainly', async () => {
    mutable['oscPat'] = undefined;
    const res = await call('PUT', '/api/v1/intercom-connection', { url: OSC_URL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, oscPatSet: false });
    expect(res.json().problem).toMatch(/OscAccessToken/);
  });

  it('osc refuses an apiKey / whipKey', async () => {
    const res = await call('PUT', '/api/v1/intercom-connection', { url: OSC_URL, apiKey: API_KEY_SECRET });
    expect(res.statusCode).toBe(400);
  });

  it('osc mode is refused for a non-OSC host (never send the instance SAT elsewhere)', async () => {
    const res = await call('PUT', '/api/v1/intercom-connection', { url: DIRECT_URL, mode: 'osc' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/osaas\.io/);
  });

  it('direct requires the API key', async () => {
    const res = await call('PUT', '/api/v1/intercom-connection', { url: DIRECT_URL });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/apiKey/);
  });

  it('direct: secrets are write-only and stored as ciphertext', async () => {
    const res = await call('PUT', '/api/v1/intercom-connection', { url: DIRECT_URL, apiKey: API_KEY_SECRET, whipKey: WHIP_SECRET });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'direct', tokenSet: true, whipKeySet: true, patSource: null, configured: true });
    const stored = store.get('intercom-connection')!;
    expect(stored.tokenEnc?.startsWith('encv1:')).toBe(true);
    expect(stored.whipKeyEnc?.startsWith('encv1:')).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(API_KEY_SECRET);
    expect(JSON.stringify(stored)).not.toContain(WHIP_SECRET);
  });

  it('keeps stored secrets for the same origin; drops them for a new origin; whipKey null clears', async () => {
    await call('PUT', '/api/v1/intercom-connection', { url: DIRECT_URL, apiKey: API_KEY_SECRET, whipKey: WHIP_SECRET });

    const same = await call('PUT', '/api/v1/intercom-connection', { url: `${DIRECT_URL}/api/v1` });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ tokenSet: true, whipKeySet: true });

    const cleared = await call('PUT', '/api/v1/intercom-connection', { url: DIRECT_URL, whipKey: null });
    expect(cleared.json()).toMatchObject({ tokenSet: true, whipKeySet: false });

    const moved = await call('PUT', '/api/v1/intercom-connection', { url: 'https://other.example.com' });
    expect(moved.statusCode).toBe(400);
  });

  it('refuses a private address, naming the allowlist; accepts it when allowlisted', async () => {
    const res = await call('PUT', '/api/v1/intercom-connection', { url: 'http://192.168.1.50:8080', apiKey: API_KEY_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/TRUSTED_INTERCOM_HOSTS/);

    mutable['trustedIntercomHosts'] = ['192.168.1.0/24'];
    const ok = await call('PUT', '/api/v1/intercom-connection', { url: 'http://192.168.1.50:8080', apiKey: API_KEY_SECRET });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().url).toBe('http://192.168.1.50:8080/api/v1');
  });

  it('a malformed URL is a 400', async () => {
    expect((await call('PUT', '/api/v1/intercom-connection', { url: 'not a url' })).statusCode).toBe(400);
  });
});

describe('DELETE', () => {
  it('is idempotent', async () => {
    expect((await call('DELETE', '/api/v1/intercom-connection')).statusCode).toBe(204);
    expect((await call('DELETE', '/api/v1/intercom-connection')).statusCode).toBe(204);
  });
});

describe('POST /test', () => {
  it('unsaved OSC URL: OK, mode osc, PAT source OscAccessToken — nothing saved', async () => {
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: OSC_URL });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, status: 'ok', mode: 'osc', patSource: 'OscAccessToken', source: 'unsaved', whipKey: 'not-used' });
    expect(store.size).toBe(0);
    // SAT exchange, then the probe, with the SAT as Bearer and redirect: manual.
    const probe = calls.find((c) => c.url.startsWith(OSC_URL))!;
    expect(probe.method).toBe('PATCH');
    expect(probe.auth).toBe(`Bearer ${SAT}`);
    expect(probe.redirect).toBe('manual');
    expect(calls.some((c) => c.url.includes('/productionlist'))).toBe(false);
  });

  it('saved OSC URL, empty body: tests the connection in effect', async () => {
    await call('PUT', '/api/v1/intercom-connection', { url: OSC_URL });
    const res = await call('POST', '/api/v1/intercom-connection/test');
    expect(res.json()).toMatchObject({ ok: true, status: 'ok', mode: 'osc', patSource: 'OscAccessToken', source: 'stored' });
  });

  it('unreachable', async () => {
    manager = 'unreachable';
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: DIRECT_URL, apiKey: API_KEY_SECRET });
    expect(res.json()).toMatchObject({ ok: false, status: 'unreachable', mode: 'direct' });
  });

  it('wrong key (direct)', async () => {
    manager = 'unauthorized';
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: DIRECT_URL, apiKey: API_KEY_SECRET, whipKey: WHIP_SECRET });
    expect(res.json()).toMatchObject({ ok: false, status: 'auth-failed', httpStatus: 401, mode: 'direct', whipKey: 'not-verifiable' });
  });

  it('SAT exchange failure (osc), with the status code', async () => {
    tokenService = 'refuse';
    mutable['oscPat'] = `${PAT_SECRET}-other`; // a PAT with no cached SAT
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: OSC_URL });
    expect(res.json()).toMatchObject({ ok: false, status: 'sat-exchange-failed', httpStatus: 401, mode: 'osc' });
  });

  it('success (direct): WHIP key reported as not verifiable', async () => {
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: DIRECT_URL, apiKey: API_KEY_SECRET, whipKey: WHIP_SECRET });
    expect(res.json()).toMatchObject({ ok: true, status: 'ok', mode: 'direct', patSource: null, whipKey: 'not-verifiable' });
    expect(calls[0].auth).toBe(`Bearer ${API_KEY_SECRET}`);
  });

  it('a redirect is not followed (no secret sent to the target)', async () => {
    manager = 'redirect';
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: DIRECT_URL, apiKey: API_KEY_SECRET });
    expect(res.json()).toMatchObject({ ok: false, status: 'unexpected-response', httpStatus: 302 });
    expect(calls.some((c) => c.url.startsWith('https://evil.example.net'))).toBe(false);
    expect(calls.every((c) => c.url === TOKEN_URL || c.redirect === 'manual')).toBe(true);
  });

  it('a URL that is not an intercom manager', async () => {
    manager = 'html';
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: DIRECT_URL, apiKey: API_KEY_SECRET });
    expect(res.json()).toMatchObject({ ok: false, status: 'unexpected-response', httpStatus: 404 });
  });

  it('osc without oscPat → missing-credential, no network call', async () => {
    mutable['oscPat'] = undefined;
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: OSC_URL });
    expect(res.json()).toMatchObject({ ok: false, status: 'missing-credential', mode: 'osc' });
    expect(calls).toHaveLength(0);
  });

  it('a private unsaved URL is refused naming the allowlist', async () => {
    const res = await call('POST', '/api/v1/intercom-connection/test', { url: 'http://10.0.0.5', apiKey: API_KEY_SECRET });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/TRUSTED_INTERCOM_HOSTS/);
    expect(calls).toHaveLength(0);
  });

  it('nothing configured', async () => {
    const res = await call('POST', '/api/v1/intercom-connection/test', {});
    expect(res.json()).toMatchObject({ ok: false, status: 'not-configured', source: 'none' });
  });

  it('env connection (direct) is tested with an empty body', async () => {
    mutable['intercomManagerUrl'] = 'https://env.example.com/api/v1';
    mutable['intercomManagerToken'] = ENV_TOKEN_SECRET;
    const res = await call('POST', '/api/v1/intercom-connection/test');
    expect(res.json()).toMatchObject({ ok: true, source: 'env', mode: 'direct' });
    expect(calls[0].url.startsWith('https://env.example.com/api/v1/production/')).toBe(true);
  });
});
