/**
 * Unit tests for StromClient.request response handling (open-live#333).
 *
 * A throwaway HTTP server stands in for Strom so the real request helper is
 * exercised on the wire. Focus: Strom's media-player control endpoints answer a
 * successful command with 200 and an empty body (no content-type). Those
 * `post<void>` calls must resolve as success — previously they fell through to
 * the "non-JSON response" throw, which the clip routes mapped to a spurious 502
 * on OSC shared-Strom deployments.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StromClient, StromClientError } from '../lib/strom.js';

// Per-request behaviour is switched via the request path so each test can drive
// a specific response shape.
const stromServer: Server = createServer((req, res) => {
  const url = req.url ?? '';
  if (url.endsWith('/empty-200')) {
    // Media-player control: 200 with an empty body and no content-type.
    res.writeHead(200);
    res.end();
    return;
  }
  if (url.endsWith('/html-200')) {
    // A 2xx that carries a non-JSON payload (e.g. a proxy landing page) must
    // still be rejected — it is not a valid empty-success response.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>hi</html>');
    return;
  }
  if (url.endsWith('/json-200')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.endsWith('/bad-gateway')) {
    // Non-2xx with an HTML body (typical funnel/proxy 502 page).
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Bad Gateway</html>');
    return;
  }
  res.writeHead(404);
  res.end();
});

let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
});

afterAll(() => stromServer.close());

// Reach past the private `post` helper to exercise the request path directly.
function post(client: StromClient, path: string): Promise<unknown> {
  return (client as unknown as { post: (p: string, b?: unknown) => Promise<unknown> }).post(path, {});
}

describe('StromClient.request', () => {
  it('treats a 2xx with an empty body as success (open-live#333)', async () => {
    const client = new StromClient({ baseUrl });
    await expect(post(client, '/empty-200')).resolves.toBeUndefined();
  });

  it('parses a 2xx JSON body normally', async () => {
    const client = new StromClient({ baseUrl });
    await expect(post(client, '/json-200')).resolves.toEqual({ ok: true });
  });

  it('rejects a 2xx that carries a non-JSON payload', async () => {
    const client = new StromClient({ baseUrl });
    await expect(post(client, '/html-200')).rejects.toBeInstanceOf(StromClientError);
  });

  it('rejects a non-2xx (proxy error page) so it surfaces as a transport error', async () => {
    const client = new StromClient({ baseUrl });
    await expect(post(client, '/bad-gateway')).rejects.toMatchObject({ status: 502 });
  });
});
