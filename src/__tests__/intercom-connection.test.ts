/**
 * Intercom connection resolver (issue #617, OL-47,
 * `docs/specs/intercom-connection.md`): URL normalisation, mode inference, the
 * SSRF gate, the stored → env → none resolution order, repointing checks and
 * the status view. CouchDB is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IntercomConnectionDoc } from '../db/types.js';

// Real encryption so stored secrets are ciphertext.
process.env['SRT_PASSPHRASE_KEY'] = Buffer.alloc(32, 7).toString('base64');

const store = new Map<string, IntercomConnectionDoc>();
let dbFails = false;

vi.mock('../db/index.js', () => ({
  getIntercomConnectionDb: () => ({
    get: vi.fn(async (id: string) => {
      if (dbFails) throw Object.assign(new Error('couch down'), { statusCode: 500 });
      const doc = store.get(id);
      if (!doc) throw Object.assign(new Error('not_found'), { statusCode: 404 });
      return doc;
    }),
  }),
  isDbConnected: () => true,
}));

const { config } = await import('../config.js');
const ic = await import('../lib/intercom-connection.js');

const mutable = config as unknown as Record<string, unknown>;
const saved = {
  intercomManagerUrl: config.intercomManagerUrl,
  intercomManagerToken: config.intercomManagerToken,
  intercomManagerAuthMode: config.intercomManagerAuthMode,
  intercomWhipAuthKey: config.intercomWhipAuthKey,
  oscPat: config.oscPat,
};

function setEnv(values: Partial<typeof saved>) {
  for (const [k, v] of Object.entries(values)) mutable[k] = v;
}

function storeDoc(doc: Partial<IntercomConnectionDoc>) {
  store.set('intercom-connection', {
    _id: 'intercom-connection',
    type: 'intercom-connection',
    url: 'https://acme-ic.eyevinn-intercom-manager.auto.prod.osaas.io/api/v1',
    mode: 'osc',
    modeOverridden: false,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...doc,
  });
}

beforeEach(() => {
  store.clear();
  dbFails = false;
  setEnv({
    intercomManagerUrl: undefined,
    intercomManagerToken: undefined,
    intercomManagerAuthMode: 'direct',
    intercomWhipAuthKey: undefined,
    oscPat: undefined,
  });
});

afterEach(() => setEnv(saved));

describe('normalizeIntercomManagerUrl', () => {
  it.each([
    ['https://ic.example.com', 'https://ic.example.com/api/v1'],
    ['https://ic.example.com/', 'https://ic.example.com/api/v1'],
    ['https://ic.example.com/api/v1', 'https://ic.example.com/api/v1'],
    ['https://ic.example.com/api/v1/', 'https://ic.example.com/api/v1'],
    ['  https://IC.Example.com:8443/prefix  ', 'https://ic.example.com:8443/prefix/api/v1'],
  ])('%s → %s', (raw, url) => {
    expect(ic.normalizeIntercomManagerUrl(raw).url).toBe(url);
  });

  it('returns the origin and the bare hostname', () => {
    const n = ic.normalizeIntercomManagerUrl('https://ic.example.com:8443/api/v1');
    expect(n.origin).toBe('https://ic.example.com:8443');
    expect(n.hostname).toBe('ic.example.com');
  });

  it.each([
    ['not a url'],
    ['ftp://ic.example.com'],
    ['https://user:pw@ic.example.com'],
    ['https://ic.example.com/api/v1?x=1'],
    ['https://ic.example.com/#frag'],
  ])('rejects %s', (raw) => {
    expect(() => ic.normalizeIntercomManagerUrl(raw)).toThrow(ic.IntercomConnectionInputError);
  });
});

describe('mode inference', () => {
  it('OSC hosts are osc, anything else is direct', () => {
    expect(ic.inferIntercomAuthMode('acme.eyevinn-intercom-manager.auto.prod.osaas.io')).toBe('osc');
    expect(ic.inferIntercomAuthMode('osaas.io')).toBe('osc');
    expect(ic.inferIntercomAuthMode('intercom.example.com')).toBe('direct');
    expect(ic.inferIntercomAuthMode('osaas.io.evil.com')).toBe('direct');
    expect(ic.inferIntercomAuthMode('notosaas.io')).toBe('direct');
  });
});

describe('assertIntercomHostAllowed (SSRF)', () => {
  it.each(['127.0.0.1', '10.0.0.5', '192.168.1.50', '169.254.169.254', '::1', 'localhost'])(
    'refuses %s, naming the allowlist',
    (host) => {
      expect(() => ic.assertIntercomHostAllowed(host, [])).toThrow(/TRUSTED_INTERCOM_HOSTS/);
    },
  );

  it('allows an allowlisted private address (literal or CIDR)', () => {
    expect(() => ic.assertIntercomHostAllowed('192.168.1.50', ['192.168.1.0/24'])).not.toThrow();
    expect(() => ic.assertIntercomHostAllowed('10.0.0.5', ['10.0.0.5'])).not.toThrow();
  });

  it('allows public hosts', () => {
    expect(() => ic.assertIntercomHostAllowed('intercom.example.com', [])).not.toThrow();
    expect(() => ic.assertIntercomHostAllowed('8.8.8.8', [])).not.toThrow();
  });
});

describe('resolveIntercomConnection — resolution order', () => {
  it('none: no stored connection and no env', async () => {
    expect(await ic.resolveIntercomConnection()).toBeUndefined();
    expect(await ic.activeIntercomConnection()).toBeUndefined();
    expect(ic.intercomConnectionStatus(undefined)).toMatchObject({ source: 'none', configured: false, url: null });
  });

  it('env only: today’s behaviour', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1', intercomManagerToken: 'env-key', intercomWhipAuthKey: 'env-whip' });
    const conn = await ic.resolveIntercomConnection();
    expect(conn).toMatchObject({
      source: 'env',
      url: 'https://env.example.com/api/v1',
      origin: 'https://env.example.com',
      mode: 'direct',
      credential: 'env-key',
      whipKey: 'env-whip',
    });
    expect(ic.intercomConnectionStatus(conn)).toMatchObject({ source: 'env', configured: true, tokenSet: true, whipKeySet: true });
  });

  it('env without a token is configured-but-unusable (talkback off, as today)', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1' });
    expect(await ic.activeIntercomConnection()).toBeUndefined();
    expect(ic.intercomConnectionStatus(await ic.resolveIntercomConnection())).toMatchObject({
      source: 'env',
      configured: false,
      problem: 'INTERCOM_MANAGER_TOKEN is not set',
    });
  });

  it('env osc mode reports INTERCOM_MANAGER_TOKEN as the PAT source', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1', intercomManagerToken: 'pat', intercomManagerAuthMode: 'osc' });
    expect(await ic.resolveIntercomConnection()).toMatchObject({ mode: 'osc', patSource: 'INTERCOM_MANAGER_TOKEN' });
  });

  it('stored only (osc): uses config.oscPat, PAT source OscAccessToken', async () => {
    setEnv({ oscPat: 'instance-pat' });
    storeDoc({});
    const conn = await ic.resolveIntercomConnection();
    expect(conn).toMatchObject({ source: 'stored', mode: 'osc', patSource: 'OscAccessToken', credential: 'instance-pat' });
    expect(ic.intercomConnectionStatus(conn)).toMatchObject({
      source: 'stored',
      configured: true,
      patSource: 'OscAccessToken',
      oscPatSet: true,
      tokenSet: false,
    });
  });

  it('stored osc without oscPat says so plainly and never falls back to another token', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1', intercomManagerToken: 'env-key' });
    storeDoc({});
    const conn = await ic.resolveIntercomConnection();
    expect(conn?.source).toBe('stored');
    expect(conn?.credential).toBeUndefined();
    expect(await ic.activeIntercomConnection()).toBeUndefined();
    const status = ic.intercomConnectionStatus(conn);
    expect(status.configured).toBe(false);
    expect(status.oscPatSet).toBe(false);
    expect(status.problem).toMatch(/OscAccessToken/);
  });

  it('both: stored wins over env', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1', intercomManagerToken: 'env-key' });
    storeDoc({
      url: 'https://stored.example.com/api/v1',
      mode: 'direct',
      tokenEnc: ic.encryptIntercomSecret('stored-key'),
      whipKeyEnc: ic.encryptIntercomSecret('stored-whip'),
    });
    const conn = await ic.resolveIntercomConnection();
    expect(conn).toMatchObject({
      source: 'stored',
      url: 'https://stored.example.com/api/v1',
      mode: 'direct',
      credential: 'stored-key',
      whipKey: 'stored-whip',
    });
    // Clearing falls back to env.
    store.clear();
    expect((await ic.resolveIntercomConnection())?.source).toBe('env');
  });

  it('stored secrets are ciphertext', () => {
    const enc = ic.encryptIntercomSecret('stored-key');
    expect(enc.startsWith('encv1:')).toBe(true);
    expect(enc).not.toContain('stored-key');
    expect(ic.decryptIntercomSecret(enc)).toBe('stored-key');
  });

  it('an undecryptable stored key makes the connection unusable with a plain reason', async () => {
    storeDoc({ url: 'https://stored.example.com/api/v1', mode: 'direct', tokenEnc: 'encv1:AAAA' });
    const conn = await ic.resolveIntercomConnection();
    expect(conn?.credential).toBeUndefined();
    expect(conn?.problem).toMatch(/could not be decrypted/);
  });

  it('a DB read failure falls back to env and never throws', async () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1', intercomManagerToken: 'env-key' });
    dbFails = true;
    expect((await ic.resolveIntercomConnection())?.source).toBe('env');
  });

  it('the status view never carries a secret value', async () => {
    storeDoc({
      url: 'https://stored.example.com/api/v1',
      mode: 'direct',
      tokenEnc: ic.encryptIntercomSecret('stored-key'),
      whipKeyEnc: ic.encryptIntercomSecret('stored-whip'),
    });
    const text = JSON.stringify(ic.intercomConnectionStatus(await ic.resolveIntercomConnection()));
    expect(text).not.toContain('stored-key');
    expect(text).not.toContain('stored-whip');
    expect(text).not.toContain('encv1:');
  });
});

describe('intercomRecordMatches (repointing)', () => {
  it('matches only the manager origin the id was recorded against', () => {
    expect(ic.intercomRecordMatches('https://a.example.com', { origin: 'https://a.example.com' })).toBe(true);
    expect(ic.intercomRecordMatches('https://a.example.com', { origin: 'https://b.example.com' })).toBe(false);
  });

  it('a pre-#617 doc (no recorded origin) belongs to the env manager', () => {
    setEnv({ intercomManagerUrl: 'https://env.example.com/api/v1' });
    expect(ic.intercomRecordMatches(undefined, { origin: 'https://env.example.com' })).toBe(true);
    expect(ic.intercomRecordMatches(undefined, { origin: 'https://b.example.com' })).toBe(false);
    setEnv({ intercomManagerUrl: undefined });
    expect(ic.intercomRecordMatches(undefined, { origin: 'https://b.example.com' })).toBe(false);
  });
});
