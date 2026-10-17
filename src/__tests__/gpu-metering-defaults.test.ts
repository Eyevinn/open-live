/**
 * Platform-hosted Strom detection and default GPU metering (issue #537).
 *
 * The rule is tested on the pure `resolveGpuMetering` with the switch passed in,
 * so the shipped `PLATFORM_DEFAULT_METERING_ENABLED = false` does not hide it.
 * The config/gate cases load `config.ts` fresh per case (it reads env at import).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import {
  PLATFORM_DEFAULT_METERING_ENABLED,
  PLATFORM_STROM_PORTS,
  resolveGpuMetering,
} from '../lib/gpu-metering-defaults.js';

const SHARED = 'https://strom-se-sto01.osaas.io:8080';
const MANAGED = { enabled: true, oscHostname: 'acme-myprod.eyevinn-open-live.auto.prod.osaas.io' };

describe('resolveGpuMetering: platform default meters', () => {
  it.each([
    [SHARED, 'se-sto01'],
    ['https://STROM-SE-STO01.OSAAS.IO:8080', 'se-sto01'],
    ['https://strom-se-sto01.osaas.io:8080/', 'se-sto01'],
    ['https://strom-se-sto01.osaas.io:8080/some/path/', 'se-sto01'],
    ['https://strom-se-sto02.osaas.io:8080', 'se-sto02'],
    ['https://strom-se-sto10.osaas.io:8080', 'se-sto10'],
  ])('%s meters with pool %s, class shared', (stromUrl, pool) => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl })).toEqual({
      pool,
      class: 'shared',
      source: 'platform-default',
    });
  });

  it('allows only port 8080', () => {
    expect(PLATFORM_STROM_PORTS).toEqual(['8080']);
  });
});

describe('resolveGpuMetering: everything else stays at zero', () => {
  it.each([
    ['no port', 'https://strom-se-sto01.osaas.io'],
    [':443', 'https://strom-se-sto01.osaas.io:443'],
    [':8082 (alternate, internal)', 'https://strom-se-sto01.osaas.io:8082'],
    [':8084 (testbed)', 'https://strom-se-sto01.osaas.io:8084'],
    ['http', 'http://strom-se-sto01.osaas.io:8080'],
    ['suffix look-alike', 'https://strom-se-sto01.osaas.io.evil.example:8080'],
    ['prefix look-alike', 'https://evil.strom-se-sto01.osaas.io:8080'],
    ['one digit', 'https://strom-se-sto1.osaas.io:8080'],
    ['three digits', 'https://strom-se-sto001.osaas.io:8080'],
    ['userinfo', 'https://user:pass@strom-se-sto01.osaas.io:8080'],
    ['username only', 'https://strom-se-sto01.osaas.io@evil.com:8080'],
    ['multi-label tenant Strom on OSC', 'https://acme-mystrom.eyevinn-strom.auto.prod.osaas.io:8080'],
    ['BYO Strom', 'https://strom.example.com:8080'],
    ['malformed', 'not a url'],
    ['empty', ''],
    ['unset', undefined],
  ])('%s: %s', (_label, stromUrl) => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl })).toBeUndefined();
  });

  it('the shared URL with OSC_HOSTNAME unset (self-hosted) is zero', () => {
    expect(resolveGpuMetering({ enabled: true, stromUrl: SHARED })).toBeUndefined();
    expect(resolveGpuMetering({ enabled: true, oscHostname: '', stromUrl: SHARED })).toBeUndefined();
  });

  it('the shared URL with the switch off (enabled=false) is zero', () => {
    expect(resolveGpuMetering({ ...MANAGED, enabled: false, stromUrl: SHARED })).toBeUndefined();
  });

  it('the same managed instance meters on the shared Strom and not on a BYO Strom', () => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: SHARED })?.pool).toBe('se-sto01');
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: 'https://gpu.customer.example:8080' })).toBeUndefined();
  });
});

describe('resolveGpuMetering: env override', () => {
  it('GPU_POOL / GPU_CLASS beat the platform default', () => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: SHARED, gpuPoolEnv: 'fra-1', gpuClassEnv: 'dedicated' })).toEqual({
      pool: 'fra-1',
      class: 'dedicated',
      source: 'env',
    });
  });

  it('GPU_CLASS alone overrides the default class on a platform match', () => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: SHARED, gpuClassEnv: 'dedicated' })).toEqual({
      pool: 'se-sto01',
      class: 'dedicated',
      source: 'platform-default',
    });
  });

  it('GPU_POOL alone still enables metering anywhere (switch off, no OSC_HOSTNAME, BYO Strom)', () => {
    expect(resolveGpuMetering({ enabled: false, gpuPoolEnv: 'fra-1', stromUrl: 'http://localhost:7000' })).toEqual({
      pool: 'fra-1',
      class: 'shared',
      source: 'env',
    });
  });

  it('GPU_CLASS alone does not enable metering', () => {
    expect(resolveGpuMetering({ enabled: true, gpuClassEnv: 'shared', stromUrl: 'http://localhost:7000' })).toBeUndefined();
  });
});

// --- config wiring and the Z1 gate (one predicate) ---

const ENV_KEYS = ['GPU_POOL', 'GPU_CLASS', 'OSC_HOSTNAME', 'STROM_URL', 'OSC_ACCESS_TOKEN', 'OSC_PAT'] as const;
const savedEnv: Record<string, string | undefined> = {};
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function setManagedSharedStromEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
  process.env['OSC_HOSTNAME'] = MANAGED.oscHostname;
  process.env['STROM_URL'] = SHARED;
  process.env['OSC_ACCESS_TOKEN'] = 'pat-1';
}

describe('config + gate wiring', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../lib/gpu-metering-defaults.js');
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('ships with the platform switch off', () => {
    expect(PLATFORM_DEFAULT_METERING_ENABLED).toBe(false);
  });

  it('with the shipped switch, a matching managed config is not metered and not gated', async () => {
    setManagedSharedStromEnv();
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBeUndefined();
    expect(config.gpuMeteringSource).toBeUndefined();
    expect(isGpuMeteringEnabled()).toBe(false);

    const gate = await import('../services/production-gate.js');
    // Balance zero would refuse a metered instance; this one is not metered.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ remainingTokens: 0 }), { status: 200 }));
    expect(await gate.checkProductionStartAllowed(log)).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate.renderProductionGateMetrics()).toEqual([]);
  });

  it('with the switch on, the same config resolves pool se-sto01 from the platform default and is gated', async () => {
    vi.doMock('../lib/gpu-metering-defaults.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../lib/gpu-metering-defaults.js')>()),
      PLATFORM_DEFAULT_METERING_ENABLED: true,
    }));
    setManagedSharedStromEnv();
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBe('se-sto01');
    expect(config.gpuClass).toBe('shared');
    expect(config.gpuMeteringSource).toBe('platform-default');
    expect(isGpuMeteringEnabled()).toBe(true);

    const gate = await import('../services/production-gate.js');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ remainingTokens: 0 }), { status: 200 }));
    const decision = await gate.checkProductionStartAllowed(log);
    expect(decision.allowed).toBe(false);
  });

  it('explicit GPU_POOL still enables metering with the shipped switch (source env)', async () => {
    setManagedSharedStromEnv();
    process.env['GPU_POOL'] = 'fra-1';
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBe('fra-1');
    expect(config.gpuMeteringSource).toBe('env');
    expect(isGpuMeteringEnabled()).toBe(true);
  });
});
