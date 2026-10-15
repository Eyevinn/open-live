/**
 * Zero-balance production start gate (issue #523).
 *
 * Rule: a NEW production cannot start while the balance is <= 0; a running
 * production is never stopped because of balance. Metered instances only
 * (GPU_POOL set); fail open on a lookup error; two counters in /metrics.
 *
 * `config.ts` reads the environment at import, so the unit tests load the
 * modules fresh per case via `vi.resetModules()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function balanceResponse(remainingTokens: unknown, status = 200): Response {
  return new Response(JSON.stringify({ remainingTokens }), { status });
}

async function loadGate(env: { gpuPool?: string; pat?: string }) {
  vi.resetModules();
  process.env['COUCHDB_URL'] = 'http://localhost:5984/db';
  delete process.env['GPU_POOL'];
  delete process.env['OSC_PAT'];
  delete process.env['OSC_ACCESS_TOKEN'];
  if (env.gpuPool) process.env['GPU_POOL'] = env.gpuPool;
  if (env.pat) process.env['OSC_ACCESS_TOKEN'] = env.pat;
  return import('../services/production-gate.js');
}

describe('checkProductionStartAllowed (#523)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['GPU_POOL'];
    delete process.env['OSC_ACCESS_TOKEN'];
  });

  it.each([0, -10])('refuses the start at balance %s with the hours message', async (balance) => {
    const gate = await loadGate({ gpuPool: 'fra-1', pat: 'pat-1' });
    fetchMock.mockResolvedValue(balanceResponse(balance));

    const decision = await gate.checkProductionStartAllowed(log);

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain('hours');
      expect(decision.message.toLowerCase()).not.toContain('token');
      expect(decision.message.toLowerCase()).not.toContain('credit');
    }
    expect(gate.getProductionGateCounters()).toEqual({ lookupErrors: 0, refusals: 1 });
  });

  it('allows the start at balance 1 (passing path) and sends the PAT to the fixed endpoint', async () => {
    const gate = await loadGate({ gpuPool: 'fra-1', pat: 'pat-1' });
    fetchMock.mockResolvedValue(balanceResponse(1));

    const decision = await gate.checkProductionStartAllowed(log);

    expect(decision).toEqual({ allowed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://money.svc.prod.osaas.io/mytokencount');
    expect(init.headers['x-pat-jwt']).toBe('Bearer pat-1');
    expect(gate.getProductionGateCounters()).toEqual({ lookupErrors: 0, refusals: 0 });
  });

  it.each([
    ['network error', () => fetchMock.mockRejectedValue(new Error('boom'))],
    ['HTTP 500', () => fetchMock.mockResolvedValue(balanceResponse(5, 500))],
    ['malformed body', () => fetchMock.mockResolvedValue(balanceResponse('lots'))],
  ])('fails open on %s, logs it and counts a lookup error', async (_name, arrange) => {
    const gate = await loadGate({ gpuPool: 'fra-1', pat: 'pat-1' });
    arrange();

    const decision = await gate.checkProductionStartAllowed(log);

    expect(decision).toEqual({ allowed: true });
    expect(log.error).toHaveBeenCalled();
    expect(gate.getProductionGateCounters()).toEqual({ lookupErrors: 1, refusals: 0 });
  });

  it('uses a 2000 ms lookup timeout and fails open when the lookup times out', async () => {
    const gate = await loadGate({ gpuPool: 'fra-1', pat: 'pat-1' });
    expect(gate.LOOKUP_TIMEOUT_MS).toBe(2000);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));

    const decision = await gate.checkProductionStartAllowed(log);

    expect(timeoutSpy).toHaveBeenCalledWith(2000);
    expect(decision).toEqual({ allowed: true });
    expect(gate.getProductionGateCounters()).toEqual({ lookupErrors: 1, refusals: 0 });
    timeoutSpy.mockRestore();
  });

  it('fails open when no OSC access token is configured', async () => {
    const gate = await loadGate({ gpuPool: 'fra-1' });

    const decision = await gate.checkProductionStartAllowed(log);

    expect(decision).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate.getProductionGateCounters().lookupErrors).toBe(1);
  });

  it('never looks up the balance on an unmetered instance (self-hosted / BYO)', async () => {
    const gate = await loadGate({ pat: 'pat-1' });
    fetchMock.mockResolvedValue(balanceResponse(-100));

    const decision = await gate.checkProductionStartAllowed(log);

    expect(decision).toEqual({ allowed: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gate.getProductionGateCounters()).toEqual({ lookupErrors: 0, refusals: 0 });
  });

  it('renders both counters on a metered instance and none on an unmetered one', async () => {
    const metered = await loadGate({ gpuPool: 'fra-1', pat: 'pat-1' });
    fetchMock.mockResolvedValue(balanceResponse(0));
    await metered.checkProductionStartAllowed(log);
    const text = metered.renderProductionGateMetrics().join('\n');
    expect(text).toContain('osc_production_gate_refusals_total 1');
    expect(text).toContain('osc_production_gate_lookup_errors_total 0');

    const unmetered = await loadGate({});
    expect(unmetered.renderProductionGateMetrics()).toEqual([]);
  });
});
