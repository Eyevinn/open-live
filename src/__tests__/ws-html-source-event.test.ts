/**
 * Tests for the HTML-source event-forwarding surface (issue #268, spec
 * docs/specs/html-source-event-forwarding.md).
 *
 * Covers:
 *  - the new HTML_SOURCE_EVENT arm of the inbound zod schema (validation),
 *  - the pure effective-URL builder (merge vs replace + graphicUrl re-validation),
 *  - the handler end-to-end: it PATCHes the running cefsrc `url` on Strom and
 *    broadcasts HTML_SOURCE_STATE; it rejects a non-HTML source, an inactive
 *    production, and a params set that would produce an SSRF/disallowed URL.
 *
 * CouchDB is mocked (productions and sources scopes are distinguished by
 * doc id prefix); a throwaway HTTP server stands in for Strom so the real
 * StromClient's request is asserted on the wire.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Mock the CouchDB layer — productions vs sources by doc id.
// ---------------------------------------------------------------------------

const productionDocs = new Map<string, Record<string, unknown>>();
const sourceDocs = new Map<string, Record<string, unknown>>();

const getProduction = vi.fn(async (id: string) => {
  const doc = productionDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});
const getSource = vi.fn(async (id: string) => {
  const doc = sourceDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});
const mockInsert = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: getProduction, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: getSource, insert: mockInsert, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Capture broadcasts
// ---------------------------------------------------------------------------

const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, message: unknown) => {
      broadcasts.push(message as Record<string, unknown>);
    },
  };
});

// ---------------------------------------------------------------------------
// A throwaway Strom the real StromClient can talk to
// ---------------------------------------------------------------------------

interface StromRequest {
  method: string;
  path: string;
  body?: unknown;
}

const stromRequests: StromRequest[] = [];

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    stromRequests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      ...(raw ? { body: JSON.parse(raw) as unknown } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => {
  stromServer.listen(0, '127.0.0.1', () => resolve());
});
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;

afterAll(() => {
  stromServer.close();
});

const { handleMessage, clearPipState, buildHtmlSourceUrl } = await import('../ws/controller.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROD = 'prod-html-abcdef01';
const FLOW = 'flow-html';
// endpointSuffix = productionId.replace(/^prod-/, '').slice(0, 8) = 'html-abc'
const CEFSRC_PATH = `/api/flows/${FLOW}/elements/e-html-0-html-abc/properties`;

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'HTML Test',
    status: 'active',
    stromFlowId: FLOW,
    mixerBlockId: 'mixer-1',
    sources: [{ sourceId: 'src-html', mixerInput: 'video_in_0' }],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'src-html',
    type: 'source',
    name: 'Lower Third',
    address: 'https://graphics.example.com/lowerthird',
    streamType: 'html',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}

function htmlStates() {
  return broadcasts.filter((m) => m.type === 'HTML_SOURCE_STATE');
}

function errorFrames() {
  return (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === 'ERROR');
}

function cefsrcRequests() {
  return stromRequests.filter((r) => r.path === CEFSRC_PATH);
}

beforeEach(() => {
  clearPipState(PROD);
  broadcasts.length = 0;
  stromRequests.length = 0;
  (ws.send as unknown as ReturnType<typeof vi.fn>).mockClear();
  getProduction.mockClear();
  getSource.mockClear();
  productionDocs.clear();
  sourceDocs.clear();
  productionDocs.set(PROD, makeProductionDoc());
  sourceDocs.set('src-html', makeSourceDoc());
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe('HTML_SOURCE_EVENT schema validation', () => {
  it('rejects a message missing params', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html' });
    expect(errorFrames()).toHaveLength(1);
    expect(cefsrcRequests()).toHaveLength(0);
  });

  it('rejects a param value over 1024 chars', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { k: 'x'.repeat(1025) } });
    expect(errorFrames()).toHaveLength(1);
    expect(cefsrcRequests()).toHaveLength(0);
  });

  it('rejects an unknown mode', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { k: 'v' }, mode: 'append' });
    expect(errorFrames()).toHaveLength(1);
    expect(cefsrcRequests()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildHtmlSourceUrl — merge / replace / SSRF re-validation
// ---------------------------------------------------------------------------

describe('buildHtmlSourceUrl', () => {
  const base = 'https://graphics.example.com/lowerthird';

  it('merge layers new keys over the current params', () => {
    const { effectiveUrl, params } = buildHtmlSourceUrl(base, { a: '1' }, { b: '2' }, 'merge');
    expect(params).toEqual({ a: '1', b: '2' });
    expect(effectiveUrl).toContain('a=1');
    expect(effectiveUrl).toContain('b=2');
  });

  it('merge overwrites an existing key', () => {
    const { params } = buildHtmlSourceUrl(base, { a: '1' }, { a: '9' }, 'merge');
    expect(params).toEqual({ a: '9' });
  });

  it('replace sets the query to exactly the given params', () => {
    const { params, effectiveUrl } = buildHtmlSourceUrl(base, { a: '1', b: '2' }, { c: '3' }, 'replace');
    expect(params).toEqual({ c: '3' });
    expect(effectiveUrl).not.toContain('a=1');
    expect(effectiveUrl).toContain('c=3');
  });

  it('rejects a base address whose host is a private IP (SSRF guard)', () => {
    expect(() => buildHtmlSourceUrl('http://169.254.169.254/', {}, { a: '1' }, 'merge')).toThrow();
  });

  it('rejects an oversized serialized query', () => {
    expect(() => buildHtmlSourceUrl(base, {}, { k: 'x'.repeat(1024), k2: 'y'.repeat(1024), k3: 'z'.repeat(1024), k4: 'w'.repeat(1024), k5: 'q'.repeat(1024) }, 'replace')).toThrow(/too long/);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour
// ---------------------------------------------------------------------------

describe('HTML_SOURCE_EVENT handler', () => {
  it('reloads the cefsrc url and broadcasts HTML_SOURCE_STATE', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { lower3: 'on', name: 'Alice' } });

    expect(errorFrames()).toHaveLength(0);
    const reqs = cefsrcRequests();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].method).toBe('PATCH');
    const body = reqs[0].body as { property_name: string; value: string };
    expect(body.property_name).toBe('url');
    expect(body.value).toContain('lower3=on');
    expect(body.value).toContain('name=Alice');

    const states = htmlStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ sourceId: 'src-html', params: { lower3: 'on', name: 'Alice' } });
    expect(typeof states[0].effectiveUrl).toBe('string');
  });

  it('merges params across successive events', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { a: '1' } });
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { b: '2' }, mode: 'merge' });
    const last = htmlStates().at(-1);
    expect(last).toMatchObject({ params: { a: '1', b: '2' } });
  });

  it('replace drops earlier params', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { a: '1' } });
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { b: '2' }, mode: 'replace' });
    const last = htmlStates().at(-1);
    expect(last?.params).toEqual({ b: '2' });
  });

  it('rejects when the production is not activated', async () => {
    productionDocs.set(PROD, makeProductionDoc({ stromFlowId: undefined }));
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { a: '1' } });
    expect(errorFrames()).toHaveLength(1);
    expect(cefsrcRequests()).toHaveLength(0);
    expect(htmlStates()).toHaveLength(0);
  });

  it('rejects a source that is not an HTML source', async () => {
    sourceDocs.set('src-html', makeSourceDoc({ streamType: 'srt', address: 'srt://1.2.3.4:9000' }));
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { a: '1' } });
    expect(errorFrames()[0]?.error).toMatch(/not an HTML source/);
    expect(cefsrcRequests()).toHaveLength(0);
  });

  it('rejects a source not assigned to the production', async () => {
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-nope', params: { a: '1' } });
    expect(errorFrames()[0]?.error).toMatch(/not found in production/);
    expect(cefsrcRequests()).toHaveLength(0);
  });

  it('rejects params that would produce a disallowed URL and does not reload', async () => {
    // A base whose host is private must be re-caught by graphicUrl on reload.
    sourceDocs.set('src-html', makeSourceDoc({ address: 'http://127.0.0.1/graphic' }));
    await send({ type: 'HTML_SOURCE_EVENT', sourceId: 'src-html', params: { a: '1' } });
    expect(errorFrames()).toHaveLength(1);
    expect(cefsrcRequests()).toHaveLength(0);
    expect(htmlStates()).toHaveLength(0);
  });
});
