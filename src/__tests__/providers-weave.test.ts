/**
 * Tests for the open-weave source provider. `fetch` is injected; no services required.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWeaveProvider, weaveProviderFromEnv } from '../providers/weave.js';
import { createSourceProviders } from '../providers/index.js';

type Route = { status: number; body?: unknown };

function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url.replace('http://weave.test', '')];
    if (!route) return new Response('not routed', { status: 500 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function provider(routes: Record<string, Route>) {
  const { impl, calls } = fakeFetch(routes);
  return { provider: createWeaveProvider({ baseUrl: 'http://weave.test/', token: 'secret-token', fetch: impl }), calls };
}

const stream = (name: string, enabled?: boolean) => ({
  name,
  ...(enabled === undefined ? {} : { enabled }),
  source: { srt: { node: 'node-1' } },
  destinations: [{ srt: { node: 'node-2' } }],
});

const endpoint = (node: string, port: number) => ({ node, host: '172.27.0.10', port, url: `srt://172.27.0.10:${port}` });

describe('weave provider', () => {
  it('maps each node-hosted output of a placed stream to a caller-mode SRT source', async () => {
    const { provider: p, calls } = provider({
      '/v1/streams': { status: 200, body: [stream('basic'), stream('fanout')] },
      '/v1/streams/basic/endpoints': { status: 200, body: { ingress: endpoint('node-1', 20001), outputs: [endpoint('node-2', 20003)] } },
      '/v1/streams/fanout/endpoints': {
        status: 200,
        body: { ingress: endpoint('node-1', 20011), outputs: [endpoint('node-2', 20013), endpoint('', 9000), endpoint('node-3', 20014)] },
      },
    });

    const sources = await p.list();

    expect(sources).toEqual([
      { externalId: 'basic/0', name: 'basic', streamType: 'srt', address: 'srt://172.27.0.10:20003?mode=caller', status: 'active' },
      { externalId: 'fanout/0', name: 'fanout (node-2)', streamType: 'srt', address: 'srt://172.27.0.10:20013?mode=caller', status: 'active' },
      { externalId: 'fanout/2', name: 'fanout (node-3)', streamType: 'srt', address: 'srt://172.27.0.10:20014?mode=caller', status: 'active' },
    ]);
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer secret-token');
    }
    expect(calls.map((c) => c.url)).toEqual([
      'http://weave.test/v1/streams',
      'http://weave.test/v1/streams/basic/endpoints',
      'http://weave.test/v1/streams/fanout/endpoints',
    ]);
  });

  it('skips disabled streams without asking for their endpoints', async () => {
    const { provider: p, calls } = provider({
      '/v1/streams': { status: 200, body: [stream('off', false), stream('on', true)] },
      '/v1/streams/on/endpoints': { status: 200, body: { ingress: endpoint('node-1', 1), outputs: [endpoint('node-2', 2)] } },
    });

    const sources = await p.list();

    expect(sources.map((s) => s.externalId)).toEqual(['on/0']);
    expect(calls.some((c) => c.url.includes('/off/'))).toBe(false);
  });

  it('skips streams that are unplaced (503) or unknown (404)', async () => {
    const { provider: p } = provider({
      '/v1/streams': { status: 200, body: [stream('pending'), stream('gone'), stream('ok')] },
      '/v1/streams/pending/endpoints': { status: 503, body: { error: 'not placed' } },
      '/v1/streams/gone/endpoints': { status: 404 },
      '/v1/streams/ok/endpoints': { status: 200, body: { ingress: endpoint('node-1', 1), outputs: [endpoint('node-2', 2)] } },
    });

    expect((await p.list()).map((s) => s.externalId)).toEqual(['ok/0']);
  });

  it('skips device ends, which weave reports as null endpoints', async () => {
    const { provider: p } = provider({
      '/v1/streams': { status: 200, body: [stream('browser-cam'), stream('browser-return')] },
      '/v1/streams/browser-cam/endpoints': { status: 200, body: { ingress: null, outputs: [endpoint('node-1', 20352)] } },
      '/v1/streams/browser-return/endpoints': { status: 200, body: { ingress: endpoint('node-1', 20617), outputs: [null] } },
    });

    expect(await p.list()).toEqual([
      { externalId: 'browser-cam/0', name: 'browser-cam', streamType: 'srt', address: 'srt://172.27.0.10:20352?mode=caller', status: 'active' },
    ]);
  });

  it('treats 401 as a configuration error without leaking the token', async () => {
    const { provider: p } = provider({ '/v1/streams': { status: 401, body: { error: 'unauthorized' } } });
    await expect(p.list()).rejects.toThrow(/401/);
    await expect(p.list()).rejects.not.toThrow(/secret-token/);
  });

  it('fails the whole listing on an unexpected status so stale sources are kept', async () => {
    const { provider: p } = provider({
      '/v1/streams': { status: 200, body: [stream('ok')] },
      '/v1/streams/ok/endpoints': { status: 500, body: { error: 'boom' } },
    });
    await expect(p.list()).rejects.toThrow(/500/);
  });

  it("carries a destination's declared SRT latency onto the matching source", async () => {
    const { provider: p } = provider({
      '/v1/streams': {
        status: 200,
        body: [{
          name: 'guest-1',
          source: { device: { node: 'guest-1' } },
          destinations: [{ srt: { node: 'node-2', latency: 200 } }],
        }],
      },
      '/v1/streams/guest-1/endpoints': { status: 200, body: { ingress: null, outputs: [endpoint('node-2', 20665)] } },
    });

    expect(await p.list()).toEqual([
      { externalId: 'guest-1/0', name: 'guest-1', streamType: 'srt', address: 'srt://172.27.0.10:20665?mode=caller', status: 'active', latency: 200 },
    ]);
  });

  it('pairs each latency with its own output, skipping the device end that holds a slot', async () => {
    const { provider: p } = provider({
      '/v1/streams': {
        status: 200,
        body: [{
          name: 'mixed',
          source: { srt: { node: 'node-1' } },
          destinations: [
            { srt: { node: 'node-2', latency: 300 } },
            { device: { node: 'screen-1' } },
            { srt: { node: 'node-3', latency: 900 } },
          ],
        }],
      },
      '/v1/streams/mixed/endpoints': {
        status: 200,
        body: { ingress: endpoint('node-1', 1), outputs: [endpoint('node-2', 2), null, endpoint('node-3', 3)] },
      },
    });

    expect((await p.list()).map((s) => [s.externalId, s.latency])).toEqual([
      ['mixed/0', 300],
      ['mixed/2', 900],
    ]);
  });

  it('falls back to open-live\'s default when a declared latency is out of range or absent', async () => {
    const { provider: p } = provider({
      '/v1/streams': {
        status: 200,
        body: [{
          name: 'odd',
          source: { srt: { node: 'node-1' } },
          destinations: [
            { srt: { node: 'node-2', latency: 19 } },
            { srt: { node: 'node-2', latency: 8001 } },
            { srt: { node: 'node-2', latency: 12.5 } },
            { srt: { node: 'node-2' } },
          ],
        }],
      },
      '/v1/streams/odd/endpoints': {
        status: 200,
        body: {
          ingress: endpoint('node-1', 1),
          outputs: [endpoint('node-2', 2), endpoint('node-2', 3), endpoint('node-2', 4), endpoint('node-2', 5)],
        },
      },
    });

    expect((await p.list()).map((s) => s.latency)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('URL-encodes stream names', async () => {
    const { provider: p, calls } = provider({
      '/v1/streams': { status: 200, body: [stream('a b/c')] },
      '/v1/streams/a%20b%2Fc/endpoints': { status: 200, body: { ingress: endpoint('node-1', 1), outputs: [endpoint('node-2', 2)] } },
    });
    expect((await p.list()).map((s) => s.externalId)).toEqual(['a b/c/0']);
    expect(calls[1].url).toBe('http://weave.test/v1/streams/a%20b%2Fc/endpoints');
  });
});

describe('provider factory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires both weave variables when weave is enabled', () => {
    vi.stubEnv('WEAVE_NORTHBOUND_URL', 'http://localhost:29080');
    vi.stubEnv('WEAVE_NORTHBOUND_TOKEN', '');
    expect(() => weaveProviderFromEnv()).toThrow('Missing required environment variable: WEAVE_NORTHBOUND_TOKEN');
  });

  it('resolves the weave id and rejects unknown ids', () => {
    vi.stubEnv('WEAVE_NORTHBOUND_URL', 'http://localhost:29080');
    vi.stubEnv('WEAVE_NORTHBOUND_TOKEN', 'tok');
    expect(createSourceProviders(['weave']).map((p) => p.id)).toEqual(['weave']);
    expect(createSourceProviders([])).toEqual([]);
    expect(() => createSourceProviders(['nope'])).toThrow("Unknown source provider 'nope' in SOURCE_PROVIDERS (known: weave)");
  });
});
