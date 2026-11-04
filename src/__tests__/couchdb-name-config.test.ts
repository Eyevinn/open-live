import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// OL-49 (issue #619): the CouchDB database name comes from COUCHDB_NAME
// (default `open-live`), is validated at config load, and connectDb() keeps an
// upgraded instance on its existing `open-live` data when the configured
// database does not exist yet.

const nanoMock = vi.hoisted(() => ({
  list: vi.fn<() => Promise<string[]>>(),
  get: vi.fn<(name: string) => Promise<{ doc_count: number }>>(),
  create: vi.fn<(name: string) => Promise<unknown>>(),
  use: vi.fn((name: string) => ({ name, info: vi.fn() })),
  factory: vi.fn(),
}));

vi.mock('nano', () => ({
  default: (opts: unknown) => {
    nanoMock.factory(opts);
    return {
      db: { list: nanoMock.list, get: nanoMock.get, create: nanoMock.create },
      use: nanoMock.use,
    };
  },
}));

import Nano from 'nano';
import { buildCouchdbName, config } from '../config.js';
import { connectDb, resolveDbName } from '../db/index.js';

function server(): Nano.ServerScope {
  return Nano('http://localhost:5984') as unknown as Nano.ServerScope;
}

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** Stub the server: `dbs` maps each existing database to its doc_count. */
function givenDatabases(dbs: Record<string, number>): void {
  nanoMock.list.mockResolvedValue(Object.keys(dbs));
  nanoMock.get.mockImplementation(async (name: string) => {
    if (!(name in dbs)) throw Object.assign(new Error('Database does not exist.'), { statusCode: 404 });
    return { doc_count: dbs[name]! };
  });
  nanoMock.create.mockResolvedValue({ ok: true });
}

beforeEach(() => {
  nanoMock.list.mockReset();
  nanoMock.get.mockReset();
  nanoMock.create.mockReset();
  nanoMock.use.mockClear();
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

  it.each(['Studio-A', '1studio', 'host:5984', '_users', 'studio a'])('rejects the invalid name %j', (name) => {
    process.env['COUCHDB_NAME'] = name;
    expect(() => buildCouchdbName()).toThrow(/COUCHDB_NAME/);
    expect(() => buildCouchdbName()).toThrow(/lowercase letter/);
  });

  it('rejects a name longer than 238 characters', () => {
    process.env['COUCHDB_NAME'] = 'a'.repeat(238);
    expect(buildCouchdbName()).toBe('a'.repeat(238));
    process.env['COUCHDB_NAME'] = 'a'.repeat(239);
    expect(() => buildCouchdbName()).toThrow(/COUCHDB_NAME.*238/s);
  });

  it('is resolved into config at load (vitest.config.ts sets open-live-test)', () => {
    expect(config.couchdbName).toBe('open-live-test');
  });
});

describe('resolveDbName', () => {
  it('uses open-live as before when it is configured and exists', async () => {
    givenDatabases({ 'open-live': 5 });
    await expect(resolveDbName(server(), 'open-live')).resolves.toBe('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
  });

  it('creates open-live as before when it is configured and missing', async () => {
    givenDatabases({});
    await expect(resolveDbName(server(), 'open-live')).resolves.toBe('open-live');
    expect(nanoMock.create).toHaveBeenCalledWith('open-live');
  });

  it('uses an existing custom database, even when open-live holds documents', async () => {
    givenDatabases({ 'studio-a': 0, 'open-live': 42 });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('falls back to a non-empty open-live, warns, and creates nothing when the custom database is missing', async () => {
    givenDatabases({ 'open-live': 42 });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = String(log.warn.mock.calls[0]![0]);
    expect(message).toContain('"studio-a"');
    expect(message).toContain('"open-live"');
  });

  it('creates the custom database when open-live is missing', async () => {
    givenDatabases({ other: 3 });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).toHaveBeenCalledWith('studio-a');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('creates the custom database when open-live exists but is empty', async () => {
    givenDatabases({ 'open-live': 0 });
    const log = makeLog();
    await expect(resolveDbName(server(), 'studio-a', log)).resolves.toBe('studio-a');
    expect(nanoMock.create).toHaveBeenCalledWith('studio-a');
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe('connectDb', () => {
  it('uses the configured database and logs its name without credentials', async () => {
    givenDatabases({ 'open-live-test': 1 });
    const log = makeLog();
    await connectDb(log);
    expect(nanoMock.use).toHaveBeenCalledWith('open-live-test');
    const messages = log.info.mock.calls.map((c) => String(c[0]));
    expect(messages).toContain('[db] Using CouchDB database "open-live-test"');
    for (const m of messages) expect(m).not.toContain(config.couchdbUrl);
  });

  it('logs the fallback database name when it falls back to open-live', async () => {
    givenDatabases({ 'open-live': 7 });
    const log = makeLog();
    await connectDb(log);
    expect(nanoMock.use).toHaveBeenCalledWith('open-live');
    expect(nanoMock.create).not.toHaveBeenCalled();
    expect(log.info.mock.calls.map((c) => String(c[0]))).toContain('[db] Using CouchDB database "open-live"');
  });
});
