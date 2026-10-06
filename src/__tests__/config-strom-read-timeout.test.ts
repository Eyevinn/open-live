/**
 * `STROM_BLOCK_PROPERTIES_READ_TIMEOUT_MS` feeds an abort timer. Node fires a
 * timer longer than 2^31 - 1 ms after 1 ms, so such a value must be refused
 * rather than make every block-properties read give up at once.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const NAME = 'STROM_BLOCK_PROPERTIES_READ_TIMEOUT_MS';

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../config.js');
  return mod.config;
}

describe('config.stromBlockPropertiesReadTimeoutMs', () => {
  beforeEach(() => {
    // config.ts calls buildCouchdbUrl() at import, which requires COUCHDB_URL.
    process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
    delete process.env[NAME];
  });

  afterEach(() => {
    delete process.env[NAME];
  });

  it('defaults to 5000 ms', async () => {
    expect((await loadConfig()).stromBlockPropertiesReadTimeoutMs).toBe(5000);
  });

  it('accepts the longest delay a timer can hold', async () => {
    process.env[NAME] = String(2 ** 31 - 1);
    expect((await loadConfig()).stromBlockPropertiesReadTimeoutMs).toBe(2 ** 31 - 1);
  });

  it('refuses a value a timer would cut to 1 ms', async () => {
    process.env[NAME] = String(2 ** 31);
    await expect(loadConfig()).rejects.toThrow(`${NAME} must be a positive integer up to 2147483647`);
  });
});
