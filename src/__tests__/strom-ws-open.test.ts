/**
 * The real StromClient runs `onOpen` exactly once per WebSocket connect. A
 * second `open` listener once made every caller (recorder subscribers, the
 * meter relay) run its connect hook twice.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { StromClient } from '../lib/strom.js';

let server: Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  wss?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  wss = undefined;
});

describe('StromClient.connectWebSocket onOpen', () => {
  it('runs once per connect', async () => {
    server = createServer();
    wss = new WebSocketServer({ server, path: '/api/ws' });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    let opens = 0;
    let closed!: () => void;
    const closedP = new Promise<void>((resolve) => (closed = resolve));
    const client = new StromClient({ baseUrl: `http://127.0.0.1:${port}` });
    const stop = client.connectWebSocket(
      () => {},
      closed,
      () => {
        opens += 1;
      },
    );

    await new Promise<void>((resolve) => wss!.once('connection', () => resolve()));
    // Let any second `open` listener fire before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    await closedP;

    expect(opens).toBe(1);
  });
});
