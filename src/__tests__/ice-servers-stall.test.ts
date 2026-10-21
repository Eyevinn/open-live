/**
 * lib/ice-servers.ts against a real HTTP server that answers the headers and
 * then stalls: the deadline the guest join passes must abort the Strom call
 * itself (StromClient's AbortSignal), body included, not only stop waiting.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

import { config } from '../config.js';
import { getIceServers, resetIceServersCache } from '../lib/ice-servers.js';

let server: http.Server;
let stromUrl: string;

beforeAll(async () => {
  // Headers at once, then a body that never comes.
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stromUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('getIceServers with a deadline, against a stalling Strom', () => {
  it('gives up at the deadline', async () => {
    const original = config.stromUrl;
    (config as { stromUrl: string }).stromUrl = stromUrl;
    try {
      resetIceServersCache();
      const started = Date.now();
      await expect(getIceServers({ timeoutMs: 300 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      (config as { stromUrl: string }).stromUrl = original;
    }
  });
});
