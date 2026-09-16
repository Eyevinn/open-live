import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCouchdbUrl } from '../config.js';

// Regression coverage for issue #288: on OSC, osc-entrypoint.sh can produce a
// truncated COUCHDB_URL like `https:/` when the operator's DatabaseUrl has no
// `/dbname` path. `new URL()` then throws an opaque `TypeError: Invalid URL`.
// buildCouchdbUrl must instead throw a clear, diagnostic Error that names the
// env var and shows the malformed value with credentials redacted.
describe('buildCouchdbUrl (issue #288)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env['COUCHDB_URL'];
    delete process.env['COUCHDB_USER'];
    delete process.env['COUCHDB_PASSWORD'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws a clear COUCHDB_URL error on a truncated value, without leaking a password', () => {
    // The exact value the OSC entrypoint bug produced in the issue logs.
    process.env['COUCHDB_URL'] = 'https:/';
    expect(() => buildCouchdbUrl()).toThrow(/COUCHDB_URL/);
    // Points the operator at the expected shape.
    expect(() => buildCouchdbUrl()).toThrow(/http\(s\):\/\/\[user:pass@\]host\[:port\]\/dbname/);
  });

  it('redacts credentials embedded in a malformed COUCHDB_URL', () => {
    // A malformed value (space in host) that still carries userinfo — the error
    // must not echo the password back.
    const secret = 'sup3r-s3cret-pw';
    process.env['COUCHDB_URL'] = `https://admin:${secret}@bad host/db`;
    let message = '';
    try {
      buildCouchdbUrl();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/COUCHDB_URL/);
    expect(message).not.toContain(secret);
    // Username may remain for diagnostics; password must be masked.
    expect(message).toContain('admin:***@');
  });

  it('parses a valid CouchDB URL unchanged when it already embeds credentials', () => {
    process.env['COUCHDB_URL'] = 'https://admin:pw@db.example.com/open-live';
    expect(buildCouchdbUrl()).toBe('https://admin:pw@db.example.com/open-live');
  });

  it('injects COUCHDB_USER/COUCHDB_PASSWORD into a credential-less valid URL', () => {
    process.env['COUCHDB_URL'] = 'https://db.example.com/open-live';
    process.env['COUCHDB_USER'] = 'admin';
    process.env['COUCHDB_PASSWORD'] = 'pw';
    expect(buildCouchdbUrl()).toBe('https://admin:pw@db.example.com/open-live');
  });
});
