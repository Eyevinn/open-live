/**
 * Platform-hosted Strom detection and default GPU metering (issues #537, #547).
 *
 * There is no switch (#547): an OSC-managed instance on the platform shared
 * Strom is always metered, and on a platform match the class is always
 * `shared`. The rule is tested on the pure `resolveGpuMetering`; the
 * config/gate/reporting cases load `config.ts` fresh per case (it reads env at
 * import).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { PLATFORM_STROM_PORTS, resolveGpuMetering } from '../lib/gpu-metering-defaults.js';

const SHARED = 'https://strom-se-sto01.osaas.io:8080';
const OSC_HOSTNAME = 'acme-myprod.eyevinn-open-live.auto.prod.osaas.io';
const MANAGED = { oscHostname: OSC_HOSTNAME };
const BYO = 'https://strom.example.com:8080';
const TENANT_STROM = 'https://acme-mystrom.eyevinn-strom.auto.prod.osaas.io:8080';

// Every STROM_URL that must stay at zero, even on a managed instance.
const UNMETERED_URLS: Array<[string, string | undefined]> = [
  ['no port', 'https://strom-se-sto01.osaas.io'],
  [':443', 'https://strom-se-sto01.osaas.io:443'],
  [':8082 (alternate, internal)', 'https://strom-se-sto01.osaas.io:8082'],
  [':8084 (testbed)', 'https://strom-se-sto01.osaas.io:8084'],
  ['http', 'http://strom-se-sto01.osaas.io:8080'],
  ['suffix look-alike', 'https://strom-se-sto01.osaas.io.evil.example:8080'],
  ['suffix look-alike (evil.com)', 'https://strom-se-sto01.osaas.io.evil.com:8080'],
  ['prefix look-alike', 'https://evil.strom-se-sto01.osaas.io:8080'],
  ['one digit', 'https://strom-se-sto1.osaas.io:8080'],
  ['three digits', 'https://strom-se-sto001.osaas.io:8080'],
  ['userinfo', 'https://user:pass@strom-se-sto01.osaas.io:8080'],
  ['username only', 'https://strom-se-sto01.osaas.io@evil.com:8080'],
  ['multi-label tenant Strom on OSC', TENANT_STROM],
  ['BYO Strom', BYO],
  ['malformed', 'not a url'],
  ['empty', ''],
  ['unset', undefined],
];

describe('resolveGpuMetering: platform default meters, with no flag or parameter', () => {
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

  it('GPU_CLASS=dedicated on a platform match still resolves class shared', () => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: SHARED, gpuClassEnv: 'dedicated' })).toEqual({
      pool: 'se-sto01',
      class: 'shared',
      source: 'platform-default',
    });
  });
});

describe('resolveGpuMetering: everything else stays at zero', () => {
  it.each(UNMETERED_URLS)('managed instance, %s: %s', (_label, stromUrl) => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl })).toBeUndefined();
  });

  it.each(UNMETERED_URLS)('no OSC_HOSTNAME, %s: %s', (_label, stromUrl) => {
    expect(resolveGpuMetering({ stromUrl })).toBeUndefined();
  });

  it('the shared URL with OSC_HOSTNAME unset (self-hosted) is zero', () => {
    expect(resolveGpuMetering({ stromUrl: SHARED })).toBeUndefined();
    expect(resolveGpuMetering({ oscHostname: '', stromUrl: SHARED })).toBeUndefined();
  });

  it('the same managed instance meters on the shared Strom and not on a BYO Strom', () => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: SHARED })?.pool).toBe('se-sto01');
    expect(resolveGpuMetering({ ...MANAGED, stromUrl: 'https://gpu.customer.example:8080' })).toBeUndefined();
  });

  it('GPU_CLASS alone does not enable metering', () => {
    expect(resolveGpuMetering({ ...MANAGED, gpuClassEnv: 'shared', stromUrl: 'http://localhost:7000' })).toBeUndefined();
    expect(resolveGpuMetering({ gpuClassEnv: 'shared', stromUrl: 'http://localhost:7000' })).toBeUndefined();
  });
});

describe('resolveGpuMetering: GPU_POOL (internal operator/test configuration)', () => {
  it.each([
    ['with OSC_HOSTNAME', MANAGED],
    ['without OSC_HOSTNAME', {}],
  ])('on the platform URL %s: source env, metering on', (_label, managed) => {
    expect(resolveGpuMetering({ ...managed, stromUrl: SHARED, gpuPoolEnv: 'fra-1' })).toEqual({
      pool: 'fra-1',
      class: 'shared',
      source: 'env',
    });
  });

  it.each([
    ['with OSC_HOSTNAME', MANAGED],
    ['without OSC_HOSTNAME', {}],
  ])('on the platform URL %s, GPU_CLASS=dedicated still resolves class shared', (_label, managed) => {
    expect(resolveGpuMetering({ ...managed, stromUrl: SHARED, gpuPoolEnv: 'fra-1', gpuClassEnv: 'dedicated' })).toEqual({
      pool: 'fra-1',
      class: 'shared',
      source: 'env',
    });
  });

  it('no GPU_POOL / GPU_CLASS value produces an unmetered or non-shared platform-hosted instance', () => {
    const pools = [undefined, 'fra-1', 'off', 'none', 'false', '0', 'se-sto01'];
    const classes = [undefined, 'shared', 'dedicated', 'none', 'off', ''];
    for (const gpuPoolEnv of pools) {
      for (const gpuClassEnv of classes) {
        const r = resolveGpuMetering({ ...MANAGED, stromUrl: SHARED, gpuPoolEnv, gpuClassEnv: gpuClassEnv || undefined });
        expect(r).toBeDefined();
        expect(r!.class).toBe('shared');
      }
    }
  });

  it('GPU_POOL enables metering anywhere (no OSC_HOSTNAME, local Strom)', () => {
    expect(resolveGpuMetering({ gpuPoolEnv: 'fra-1', stromUrl: 'http://localhost:7000' })).toEqual({
      pool: 'fra-1',
      class: 'shared',
      source: 'env',
    });
  });

  it.each([
    ['BYO', BYO],
    ['tenant Strom', TENANT_STROM],
    [':8082', 'https://strom-se-sto01.osaas.io:8082'],
    ['local', 'http://localhost:7000'],
  ])('off a platform URL (%s), GPU_POOL + GPU_CLASS=dedicated yields dedicated (dashboard label)', (_label, stromUrl) => {
    expect(resolveGpuMetering({ ...MANAGED, stromUrl, gpuPoolEnv: 'fra-1', gpuClassEnv: 'dedicated' })).toEqual({
      pool: 'fra-1',
      class: 'dedicated',
      source: 'env',
    });
  });
});

// --- config wiring, the Z1 gate and the reporting surfaces (one predicate) ---

const ENV_KEYS = ['GPU_POOL', 'GPU_CLASS', 'OSC_HOSTNAME', 'STROM_URL', 'OSC_ACCESS_TOKEN', 'OSC_PAT', 'COUCHDB_URL'] as const;
const savedEnv: Record<string, string | undefined> = {};
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function setEnv(opts: { stromUrl?: string; oscHostname?: string; gpuPool?: string; gpuClass?: string }): void {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
  process.env['OSC_ACCESS_TOKEN'] = 'pat-1';
  if (opts.stromUrl !== undefined) process.env['STROM_URL'] = opts.stromUrl;
  if (opts.oscHostname !== undefined) process.env['OSC_HOSTNAME'] = opts.oscHostname;
  if (opts.gpuPool !== undefined) process.env['GPU_POOL'] = opts.gpuPool;
  if (opts.gpuClass !== undefined) process.env['GPU_CLASS'] = opts.gpuClass;
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
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('a managed shared-Strom instance with no env override is metered (pool se-sto01, platform-default)', async () => {
    setEnv({ stromUrl: SHARED, oscHostname: OSC_HOSTNAME });
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBe('se-sto01');
    expect(config.gpuClass).toBe('shared');
    expect(config.gpuMeteringSource).toBe('platform-default');
    expect(isGpuMeteringEnabled()).toBe(true);
  });

  it('GPU_CLASS=dedicated on the managed shared-Strom instance is still class shared', async () => {
    setEnv({ stromUrl: SHARED, oscHostname: OSC_HOSTNAME, gpuClass: 'dedicated' });
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuClass).toBe('shared');
    expect(isGpuMeteringEnabled()).toBe(true);
  });

  it('the gate refuses a new production at zero balance on a managed shared-Strom instance with no override', async () => {
    setEnv({ stromUrl: SHARED, oscHostname: OSC_HOSTNAME });
    const gate = await import('../services/production-gate.js');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ remainingTokens: 0 }), { status: 200 }));
    const decision = await gate.checkProductionStartAllowed(log);
    expect(decision.allowed).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('explicit GPU_POOL on the managed shared-Strom instance: source env, metering on', async () => {
    setEnv({ stromUrl: SHARED, oscHostname: OSC_HOSTNAME, gpuPool: 'fra-1', gpuClass: 'dedicated' });
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBe('fra-1');
    expect(config.gpuClass).toBe('shared');
    expect(config.gpuMeteringSource).toBe('env');
    expect(isGpuMeteringEnabled()).toBe(true);
  });

  const unmeteredConfigs: Array<[string, { stromUrl?: string; oscHostname?: string }]> = [
    ...UNMETERED_URLS.filter(([, u]) => u !== undefined).flatMap(([label, stromUrl]): Array<[string, { stromUrl?: string; oscHostname?: string }]> => [
      [`managed, ${label}`, { stromUrl, oscHostname: OSC_HOSTNAME }],
      [`self-hosted, ${label}`, { stromUrl }],
    ]),
    ['platform URL without OSC_HOSTNAME', { stromUrl: SHARED }],
  ];

  it.each(unmeteredConfigs)('%s: not metered, not gated, reports zero', async (_label, opts) => {
    setEnv(opts);
    const { config, isGpuMeteringEnabled } = await import('../config.js');
    expect(config.gpuPool).toBeUndefined();
    expect(config.gpuMeteringSource).toBeUndefined();
    expect(isGpuMeteringEnabled()).toBe(false);

    const gate = await import('../services/production-gate.js');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ remainingTokens: 0 }), { status: 200 }));
    expect(await gate.checkProductionStartAllowed(log)).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();

    const usage = await import('../services/gpu-usage.js');
    expect((await usage.buildGpuUsageResponse({}, log)).hours).toEqual([]);
    const metrics = await usage.buildPrometheusMetrics(log);
    // No osc_gpu_* sample of any family (HELP/TYPE comment lines start with '#').
    expect(metrics).not.toMatch(/^osc_gpu_/m);
  });
});
