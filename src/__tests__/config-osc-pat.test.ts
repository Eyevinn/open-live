/**
 * Tests for how `config.oscPat` is resolved from the environment (issue #318).
 *
 * The SAT-exchange endpoint (POST /api/v1/auth/token, #204) returns
 * `503 "Token exchange is not configured"` whenever `config.oscPat` is unset.
 * OSC provisions the token via the `OscAccessToken` service config option, which
 * the platform maps onto the `OSC_ACCESS_TOKEN` env var — but the original code
 * only read `OSC_PAT`, so a correctly-provisioned instance still 503'd. These
 * tests pin the precedence: `OSC_PAT` first (backward compat), then
 * `OSC_ACCESS_TOKEN`.
 *
 * `config.ts` reads the environment once at module load, so each case sets the
 * env and imports the module fresh via `vi.resetModules()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const OSC_PAT = 'pat-from-osc-pat';
const OSC_ACCESS_TOKEN = 'pat-from-osc-access-token';

async function loadConfig() {
  vi.resetModules();
  const mod = await import('../config.js');
  return mod.config;
}

describe('config.oscPat env resolution (#318)', () => {
  beforeEach(() => {
    // config.ts calls buildCouchdbUrl() at import, which requires COUCHDB_URL.
    process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
    delete process.env['OSC_PAT'];
    delete process.env['OSC_ACCESS_TOKEN'];
  });

  afterEach(() => {
    delete process.env['OSC_PAT'];
    delete process.env['OSC_ACCESS_TOKEN'];
  });

  it('falls back to OSC_ACCESS_TOKEN when OSC_PAT is unset (the #318 fix)', async () => {
    process.env['OSC_ACCESS_TOKEN'] = OSC_ACCESS_TOKEN;
    const config = await loadConfig();
    expect(config.oscPat).toBe(OSC_ACCESS_TOKEN);
  });

  it('uses OSC_PAT when only it is set', async () => {
    process.env['OSC_PAT'] = OSC_PAT;
    const config = await loadConfig();
    expect(config.oscPat).toBe(OSC_PAT);
  });

  it('prefers OSC_PAT over OSC_ACCESS_TOKEN when both are set', async () => {
    process.env['OSC_PAT'] = OSC_PAT;
    process.env['OSC_ACCESS_TOKEN'] = OSC_ACCESS_TOKEN;
    const config = await loadConfig();
    expect(config.oscPat).toBe(OSC_PAT);
  });

  it('is undefined when neither is set (endpoint then 503s)', async () => {
    const config = await loadConfig();
    expect(config.oscPat).toBeUndefined();
  });
});
