import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OL-49 (issue #619): the CouchDB database name comes from COUCHDB_NAME
// (default `open-live`). resolveDbName() keeps an upgraded instance on its
// existing `open-live` data while the configured database is missing or has no
// `open-live-database` marker, and for an invalid name falls back to an
// `open-live` with data or else fails with a non-retried FatalStartupError.

type Row = { id: string };

const nanoMock = vi.hoisted(() => ({
  /** Existing databases and their document ids (sorted on read, like _all_docs). */
  dbs: {} as Record<string, string[]>,
  list: vi.fn<() => Promise<string[]>>(),
  create: vi.fn<(name: string) => Promise<unknown>>(),
  insert: vi.fn<(name: string, doc: { _id: string }) => Promise<unknown>>(),
  docList: vi.fn<(name: string, params: { limit: number; startkey?: string; skip?: number }) => Promise<{ rows: Row[] }>>(),
  use: vi.fn(),
  factory: vi.fn(),
}));

vi.mock('nano', () => ({
  default: (opts: unknown) => {
    nanoMock.factory(opts);
    return {
      db: { list: nanoMock.list, create: nanoMock.create },
      use: nanoMock.use,
    };
  },
}));

import Nano from 'nano';
import { buildCouchdbName, config, couchdbNameProblem } from '../config.js';
import { FatalStartupError, isFatalStartupError } from '../lib/fatal-startup-error.js';
import { BOOKKEEPING_DOC_IDS, DATABASE_MARKER_DOC_ID, connectDb, isDataDocId, resolveDbName } from '../db/index.js';
import { GUEST_SIGNING_KEY_DOC_ID } from '../lib/guest-signing-key.js';
import { CREDENTIAL_ENCRYPTION_KEY_DOC_ID } from '../lib/credential-encryption-key.js';
import { RTMP_CREDENTIAL_KEY_DOC_ID } from '../lib/rtmp-credential-key.js';
import { GPU_METERING_STATE_DOC_ID } from '../services/gpu-usage.js';

function server(): Nano.ServerScope {
  return Nano('http://localhost:5984') as unknown as Nano.ServerScope;
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** What every started instance writes for itself, whether used or not. */
const KEY_DOCS = ['credential-encryption-key', 'guest-invite-signing-key', 'rtmp-credentials-key', 'migration:recording-kind-v1'];

/** Stub the server: `dbs` maps each existing database to its document ids. */
function givenDatabases(dbs: Record<string, string[]>): void {
  nanoMock.dbs = Object.fromEntries(Object.entries(dbs).map(([k, v]) => [k, [...v]]));
}

beforeEach(() => {
  nanoMock.dbs = {};
  nanoMock.list.mockReset().mockImplementation(async () => Object.keys(nanoMock.dbs));
  nanoMock.create.mockReset().mockImplementation(async (name: string) => {
    nanoMock.dbs[name] = [];
    return { ok: true };
  });
  nanoMock.insert.mockReset().mockImplementation(async (name: string, doc: { _id: string }) => {
    const ids = nanoMock.dbs[name]!;
    if (ids.includes(doc._id)) throw Object.assign(new Error('Document update conflict.'), { statusCode: 409 });
    ids.push(doc._id);
    return { ok: true };
  });
  nanoMock.docList.mockReset().mockImplementation(async (name, params) => {
    const ids = [...nanoMock.dbs[name]!].sort();
    const from = params.startkey === undefined ? 0 : ids.indexOf(params.startkey) + (params.skip ?? 0);
    return { rows: ids.slice(from, from + params.limit).map((id) => ({ id })) };
  });
  nanoMock.use.mockReset().mockImplementation((name: string) => ({
    name,
    info: vi.fn(),
    list: (params: { limit: number; startkey?: string; skip?: number }) => nanoMock.docList(name, params),
    insert: (doc: { _id: string }) => nanoMock.insert(name, doc),
    get: async (id: string) => {
      if (!nanoMock.dbs[name]!.includes(id)) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return { _id: id };
    },
  }));
  nanoMock.factory.mockClear();
});

describe('buildCouchdbName (COUCHDB_NAME)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to open-live when COUCHDB_NAME is unset', () => {
    delete process.env['COUCHDB_NAME'];
    expect(buildCouchdbName()).toBe('open-live');
  });

  it('defaults to open-live when COUCHDB_NAME is empty or whitespace', () => {
    process.env['COUCHDB_NAME'] = '';
    expect(buildCouchdbName()).toBe('open-live');
    process.env['COUCHDB_NAME'] = '   ';
    expect(buildCouchdbName()).toBe('open-live');
  });

  it('returns a valid configured name, trimmed', () => {
    process.env['COUCHDB_NAME'] = ' studio-a ';
    expect(buildCouchdbName()).toBe('studio-a');
    process.env['COUCHDB_NAME'] = 'studios/a_b$(1)+2';
    expect(buildCouchdbName()).toBe('studios/a_b$(1)+2');
  });

  it('returns an invalid name unchanged: it is judged against the server in resolveDbName (#619 AC4)', () => {
    process.env['COUCHDB_NAME'] = 'OpenLive';
    expect(buildCouchdbName()).toBe('OpenLive');
  });
  it('is resolved into config at load (vitest.config.ts sets open-live-test)', () => {
    expect(config.couchdbName).toBe('open-live-test');
  });
});

describe('couchdbNameProblem', () => {
  it.each(['studio-a', 'open-live', 'studios/a_b$(1)+2', 'a'.repeat(238)])('accepts the valid name %j', (name) => {
    expect(couchdbNameProblem(name)).toBeNull();
  });

  it.each(['Studio-A', 'OpenLive', 'openlive.db', '1studio', 'host:5984', '_users', 'studio a', 'open-live?x=1'])(
    'rejects the invalid name %j, naming COUCHDB_NAME and the rule',
    (name) => {
      const problem = couchdbNameProblem(name);
      expect(problem).toMatch(/COUCHDB_NAME/);
      expect(problem).toMatch(/lowercase letter/);
    },
  );

  it('rejects a name longer than 238 characters', () => {
    expect(couchdbNameProblem('a'.repeat(239))).toMatch(/COUCHDB_NAME.*238/s);
  });

  it('does not echo the invalid value, which on OSC can be part of the DatabaseUrl credentials', () => {
    // DatabaseUrl with no db path and a password containing "/": COUCHDB_NAME
    // becomes the tail of the password plus the host.
    const message = couchdbNameProblem('34secret@couch.example')!;
    expect(message).toMatch(/COUCHDB_NAME/);
    expect(message).toContain('22 characters');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('couch.example');
    expect(couchdbNameProblem('admin:pw')).toMatch(/^(?!.*pw).*COUCHDB_NAME/s);
  });
});

describe('resolveDbName with an invalid COUCHDB_NAME (#619 AC3/AC4)', () => {
  it.each(['OpenLive', 'openlive.db', '_users', 'open-live?x=1'])(
    'keeps an upgraded instance with the DatabaseUrl tail %j on open-live with data, logging an error',
    async (name) => {
      givenDatabases({ 'open-live': ['prod-1', ...KEY_DOCS] });
      const log = makeLog();
      await expect(resolveDbName(server(), name, log)).resolves.toBe('open-live');
      expect(nanoMock.create).not.toHaveBeenCalled();
      expect(nanoMock.insert).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalledTimes(1);
      const message = String(log.error.mock.calls[0]![0]);
      expect(message).toContain('COUCHDB_NAME');
      expect(message).toMatch(/lowercase letter/);
      expect(message).toContain('"open-live"');
      expect(message).not.toContain(name);
    },
  );

  it('fails with a FatalStartupError when open-live is missing', async () => {
    givenDatabases({ other: ['x'] });
    const err = await resolveDbName(server(), 'OpenLive', makeLog()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FatalStartupError);
    expect(isFatalStartupError(err)).toBe(true);
    expect((err as Error).message).toMatch(/COUCHDB_NAME.*lowercase letter/s);
    expect((err as Error).message).not.toContain('OpenLive');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.use).not.toHaveBeenCalledWith('OpenLive');
  });

  it('fails with a FatalStartupError when open-live holds only bookkeeping documents', async () => {
    givenDatabases({ 'open-live': ['_design/app', 'gpu-metering-state', ...KEY_DOCS] });
    await expect(resolveDbName(server(), '_users', makeLog())).rejects.toBeInstanceOf(FatalStartupError);
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.insert).not.toHaveBeenCalled();
  });
});

describe('resolveDbName', () => {
  it('uses open-live as before when it is configured and exists', async () => {
    givenDatabases({ 'open-live': ['prod-1'] });
    await expect(resolveDbName(server(), 'open-live')).resolves.toBe('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.insert).not.toHaveBeenCalled();
  });

  it('creates open-live as before when it is configured and missing', async () => {
    givenDatabases({});
    await expect(resolveDbName(server(), 'open-live')).resolves.toBe('open-live');
    expect(nanoMock.create).toHaveBeenCalledWith('open-live');
    expect(nanoMock.insert).not.toHaveBeenCalled();
  });

  it('uses an existing custom database that holds the marker, even when open-live holds data', async () => {
    givenDatabases({ 'studio-a': [DATABASE_MARKER_DOC_ID, 'prod-9', ...KEY_DOCS], 'open-live': ['prod-1', ...KEY_DOCS] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.insert).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not switch to a custom database with foreign documents but no marker while open-live holds data', async () => {
    // Another app's database on the same CouchDB, named by the DatabaseUrl tail.
    givenDatabases({ 'studio-a': ['user-1', 'invoice-7'], 'open-live': ['prod-1', ...KEY_DOCS] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('open-live');
    expect(nanoMock.insert).not.toHaveBeenCalled();
    expect(nanoMock.dbs['studio-a']).toEqual(['user-1', 'invoice-7']);
    const message = String(log.error.mock.calls[0]![0]);
    expect(message).toContain(`has no "${DATABASE_MARKER_DOC_ID}" marker document`);
    expect(message).toContain('was not written to');
  });

  it('claims a custom database with documents but no marker when open-live holds no data', async () => {
    givenDatabases({ 'studio-a': ['prod-9'], 'open-live': [...KEY_DOCS] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('studio-a');
    expect(nanoMock.dbs['studio-a']).toContain(DATABASE_MARKER_DOC_ID);
  });

  it('uses a custom database that only holds the marker document (operator pre-claim)', async () => {
    givenDatabases({ 'studio-a': [DATABASE_MARKER_DOC_ID], 'open-live': ['prod-1'] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('studio-a');
  });

  it('falls back to open-live with data, logs an error, and creates nothing when the custom database is missing', async () => {
    givenDatabases({ 'open-live': ['prod-1', ...KEY_DOCS] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.insert).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    const message = String(log.error.mock.calls[0]![0]);
    expect(message).toContain('"studio-a"');
    expect(message).toContain('does not exist');
    expect(message).toContain('"open-live"');
  });

  it('falls back to open-live with data when the custom database exists but is empty (AC4: pre-created DB)', async () => {
    givenDatabases({ 'studio-a': ['_design/app'], 'open-live': ['src-1', ...KEY_DOCS] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.insert).not.toHaveBeenCalled();
    const message = String(log.error.mock.calls[0]![0]);
    expect(message).toContain('marker document');
    expect(message).toContain('was not written to');
  });

  it('names the shared-server risk and the pre-claim remedy in the fallback error', async () => {
    givenDatabases({ 'open-live': ['prod-1'] });
    const log = makeLog();
    await resolveDbName(server(), 'studio-a', log);
    const message = String(log.error.mock.calls[0]![0]);
    expect(message).toContain(`PUT /studio-a/${DATABASE_MARKER_DOC_ID} with {}`);
    expect(message).toMatch(/shared/);
    expect(message).toMatch(/sharing "open-live"/);
    expect(message).toContain(`"${DATABASE_MARKER_DOC_ID}"`);
  });

  it('treats settings documents in open-live as data', async () => {
    givenDatabases({ 'open-live': ['intercom-connection', ...KEY_DOCS] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('open-live');
  });

  it('finds data in open-live past a full page of bookkeeping and design ids', async () => {
    const design = Array.from({ length: 150 }, (_, i) => `_design/v${String(i).padStart(3, '0')}`);
    givenDatabases({ 'open-live': [...design, ...KEY_DOCS, 'prod-1'] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('open-live');
    expect(nanoMock.docList.mock.calls.filter(([name]) => name === 'open-live').length).toBeGreaterThan(1);
  });

  it('creates the custom database and writes the marker when open-live is missing', async () => {
    givenDatabases({ other: ['x'] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).toHaveBeenCalledWith('studio-a');
    expect(nanoMock.dbs['studio-a']).toEqual([DATABASE_MARKER_DOC_ID]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('creates the custom database when open-live holds only bookkeeping documents (started once, never used)', async () => {
    givenDatabases({ 'open-live': ['_design/app', 'gpu-metering-state', ...KEY_DOCS] });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).toHaveBeenCalledWith('studio-a');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('claims an existing empty custom database when open-live holds no data', async () => {
    givenDatabases({ 'studio-a': [] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('studio-a');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(nanoMock.dbs['studio-a']).toEqual([DATABASE_MARKER_DOC_ID]);
  });

  it('stays on its own database once claimed, even after open-live later gains data', async () => {
    givenDatabases({ 'open-live': [] });
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('studio-a');
    nanoMock.dbs['open-live']!.push('prod-1');
    await expect(resolveDbName(server(), 'studio-a', makeLog())).resolves.toBe('studio-a');
  });

  it('tolerates a marker written concurrently (409) and rethrows other write errors', async () => {
    givenDatabases({ 'studio-a': [] });
    nanoMock.insert.mockRejectedValueOnce(Object.assign(new Error('conflict'), { statusCode: 409 }));
    await expect(resolveDbName(server(), 'studio-a')).resolves.toBe('studio-a');
    nanoMock.insert.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { statusCode: 403 }));
    await expect(resolveDbName(server(), 'studio-a')).rejects.toThrow('forbidden');
  });
});

describe('isDataDocId / BOOKKEEPING_DOC_IDS', () => {
  it('lists the fixed ids the key, GPU-metering and marker modules write', () => {
    for (const id of [
      GUEST_SIGNING_KEY_DOC_ID,
      CREDENTIAL_ENCRYPTION_KEY_DOC_ID,
      RTMP_CREDENTIAL_KEY_DOC_ID,
      GPU_METERING_STATE_DOC_ID,
      DATABASE_MARKER_DOC_ID,
    ]) {
      expect(BOOKKEEPING_DOC_IDS.has(id)).toBe(true);
      expect(isDataDocId(id)).toBe(false);
    }
  });

  it('excludes design and migration documents and counts everything else', () => {
    expect(isDataDocId('_design/app')).toBe(false);
    expect(isDataDocId('migration:audio-channel-order-v2')).toBe(false);
    for (const id of ['prod-1', 'src-1', 'cfg-1', 'intercom-connection', 'default']) expect(isDataDocId(id)).toBe(true);
  });
});

describe('connectDb', () => {
  it('uses the configured database and logs its name without credentials', async () => {
    givenDatabases({ 'open-live-test': ['prod-1'] });
    const log = makeLog();
    await connectDb(log);
    expect(nanoMock.use).toHaveBeenLastCalledWith('open-live-test');
    const messages = log.info.mock.calls.map((c) => String(c[0]));
    expect(messages).toContain('[db] Using CouchDB database "open-live-test"');
    for (const m of messages) expect(m).not.toContain(config.couchdbUrl);
  });

  it('logs the fallback database name when it falls back to open-live', async () => {
    givenDatabases({ 'open-live': ['prod-1'] });
    const log = makeLog();
    await connectDb(log);
    expect(nanoMock.use).toHaveBeenLastCalledWith('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map((c) => String(c[0]))).toContain('[db] Using CouchDB database "open-live"');
  });
});
