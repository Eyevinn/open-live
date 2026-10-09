/**
 * Tests `reinitConnectedControllers` (issue #416): when a production reactivates
 * with a NEW Strom flow while a controller socket stayed open across the
 * deactivate, the activation path must re-run first-connect audio init ONCE and
 * push the fresh defaults to the connected operator(s) — instead of leaving the
 * mixer un-initialised until the next fresh connect (which would then clobber
 * any change made since reactivation).
 *
 * Uses a throwaway HTTP server as Strom (serves the running flow + accepts the
 * init PATCH) with the token exchange and the relay `ws` sockets mocked, and a
 * fake subscribed socket so `getSubscriberCount` is non-zero and the broadcast
 * frames are captured.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// --- Production doc the reinit reads ---
const productionDocs = new Map<string, Record<string, unknown>>();
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async (id: string) => {
      const doc = productionDocs.get(id);
      if (!doc) throw new Error('not_found');
      return doc;
    }),
    insert: vi.fn().mockResolvedValue({ ok: true }),
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getSourcesDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/strom-token.js', () => ({ getStromToken: vi.fn().mockResolvedValue(undefined) }));

// Mock the relay `ws` sockets so startMeterRelay/startClipRelay do not open real
// connections — we only care that reinit runs audio init + the broadcast here.
vi.mock('ws', () => {
  class FakeWebSocket {
    constructor(_url: string, _opts?: unknown) {}
    on() {}
    close() {}
  }
  return { WebSocket: FakeWebSocket };
});

// --- Throwaway Strom: serves the running flow, counts init PATCHes ---
let numChannels = 2;
// Properties the init PATCH refuses, with the current value Strom reports for each.
let patchRejected: Record<string, { reason: string; current: unknown }> = {};
// The new flow's main mute, returned with every write; undefined omits it.
let stromMainMute: boolean | undefined = false;
const propertyPatches: Array<Record<string, unknown>> = [];
const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const url = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && /\/api\/flows\/[^/]+$/.test(url)) {
      res.end(JSON.stringify({ flow: { blocks: [{ id: 'audio-mixer-1', block_definition_id: 'builtin.mixer', properties: { num_channels: numChannels } }] } }));
      return;
    }
    if (req.method === 'PATCH' && url.endsWith('/properties')) {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      propertyPatches.push(body.properties ?? {});
      const properties: Record<string, unknown> = { ...(stromMainMute === undefined ? {} : { main_mute: stromMainMute }), ...(body.properties ?? {}) };
      const rejected: Record<string, string> = {};
      for (const [key, { reason, current }] of Object.entries(patchRejected)) {
        properties[key] = current;
        rejected[key] = reason;
      }
      res.end(JSON.stringify({ block_id: 'audio-mixer-1', properties, rejected }));
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});
await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { reinitConnectedControllers, clearAudioState } = await import('../ws/controller.js');
const { subscribe, unsubscribe } = await import('../services/tally.service.js');

const PROD = 'prod-reinit-01';

interface FakeSocket { readyState: number; OPEN: number; sent: Array<Record<string, unknown>>; send(p: string): void }
function makeSocket(): FakeSocket {
  return { readyState: 1, OPEN: 1, sent: [], send(p: string) { this.sent.push(JSON.parse(p) as Record<string, unknown>); } };
}

function activeDoc(): Record<string, unknown> {
  return { _id: PROD, type: 'production', status: 'active', stromFlowId: 'flow-new', audioMixerBlockId: 'audio-mixer-1', loudnessMainBlockId: 'loud-1' };
}

beforeEach(() => {
  propertyPatches.length = 0;
  patchRejected = {};
  stromMainMute = false;
  clearAudioState(PROD); // simulate deactivate having wiped the registries
  productionDocs.clear();
  productionDocs.set(PROD, activeDoc());
});

describe('reinitConnectedControllers', () => {
  it('runs audio init once and pushes fresh defaults to the connected operator', async () => {
    const sock = makeSocket();
    subscribe(PROD, sock as never);
    try {
      await reinitConnectedControllers(PROD);

      // One init PATCH carrying the per-channel fader/mute/route defaults.
      expect(propertyPatches).toHaveLength(1);
      expect(propertyPatches[0]).toMatchObject({ ch1_fader: 1.0, ch1_mute: false, ch1_to_main: true, ch2_fader: 1.0, main_fader: 1.0 });

      // The connected socket receives the reset channel + main state and a GRP reset.
      const audio = sock.sent.filter((m) => m.type === 'AUDIO_STATE');
      expect(audio).toContainEqual(expect.objectContaining({ type: 'AUDIO_STATE', elementId: 'ch1', property: 'volume', value: 1.0 }));
      expect(audio).toContainEqual(expect.objectContaining({ type: 'AUDIO_STATE', elementId: 'ch1', property: 'mute', value: false }));
      expect(audio).toContainEqual(expect.objectContaining({ type: 'AUDIO_STATE', elementId: 'main', property: 'volume', value: 1.0 }));
      expect(sock.sent.some((m) => m.type === 'GRP_STATE_RESET')).toBe(true);
    } finally {
      unsubscribe(PROD, sock as never);
    }
  });

  it('reports a channel Strom refused to route to main as muted, and skips a refused fader', async () => {
    patchRejected = {
      ch1_to_main: { reason: 'guarded', current: false },
      ch2_fader: { reason: 'out of range', current: 0.4 },
    };
    const sock = makeSocket();
    subscribe(PROD, sock as never);
    try {
      await reinitConnectedControllers(PROD);

      const audio = sock.sent.filter((m) => m.type === 'AUDIO_STATE');
      expect(audio).toContainEqual(expect.objectContaining({ elementId: 'ch1', property: 'mute', value: true }));
      expect(audio).toContainEqual(expect.objectContaining({ elementId: 'ch2', property: 'mute', value: false }));
      expect(audio).not.toContainEqual(expect.objectContaining({ elementId: 'ch2', property: 'volume' }));
      expect(audio).toContainEqual(expect.objectContaining({ elementId: 'ch1', property: 'volume', value: 1.0 }));
    } finally {
      unsubscribe(PROD, sock as never);
    }
  });

  it('tells a socket that stayed open the new flow\'s main mute, without writing it', async () => {
    const sock = makeSocket();
    subscribe(PROD, sock as never);
    try {
      await reinitConnectedControllers(PROD);

      expect(propertyPatches[0]).not.toHaveProperty('main_mute');
      expect(sock.sent).toContainEqual(expect.objectContaining({ type: 'AUDIO_STATE', elementId: 'main', property: 'mute', value: false }));

      sock.sent.length = 0;
      clearAudioState(PROD);
      stromMainMute = undefined;
      await reinitConnectedControllers(PROD);
      // Strom did not say: nothing is reported.
      expect(sock.sent).not.toContainEqual(expect.objectContaining({ elementId: 'main', property: 'mute' }));
    } finally {
      unsubscribe(PROD, sock as never);
    }
  });

  it('does not re-init (no clobber) once the registry is warm', async () => {
    const sock = makeSocket();
    subscribe(PROD, sock as never);
    try {
      await reinitConnectedControllers(PROD); // first call inits
      expect(propertyPatches).toHaveLength(1);
      // A second activation pass (e.g. a later fresh connect) must not re-run init
      // and reset channels the operator may have since changed.
      await reinitConnectedControllers(PROD);
      expect(propertyPatches).toHaveLength(1);
    } finally {
      unsubscribe(PROD, sock as never);
    }
  });

  it('is a no-op when no controller is connected', async () => {
    await reinitConnectedControllers(PROD);
    expect(propertyPatches).toHaveLength(0);
  });
});
