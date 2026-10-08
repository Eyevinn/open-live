/**
 * Watch-only controller connections (`?mode=watch`).
 *
 * A passive subscriber (e.g. a tally logger) must be able to follow a
 * production without side effects: the first operator connect after
 * (re)activation runs the audio-mixer reset, and a watcher arriving first must
 * not trigger it. Watchers must also not send commands, not count as
 * operators, and not keep a production alive against the idle watchdog.
 *
 * Uses the real controller plugin over a live socket (the connect handler is
 * where first-connect init lives). CouchDB is mocked; a throwaway HTTP server
 * stands in for Strom and records every write.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

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
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: vi.fn(),
  deactivateStromFlow: vi.fn(),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const notifySubscriberJoin = vi.fn();
vi.mock('../services/idle-watchdog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/idle-watchdog.js')>();
  return {
    ...actual,
    notifySubscriberJoin: (id: string) => {
      notifySubscriberJoin(id);
      actual.notifySubscriberJoin(id);
    },
  };
});

// Live ref count per production and relay. As in the real relays, a stop with no
// live relay is a no-op.
const relayRefCounts = new Map<string, { meter: number; clip: number }>();
const relayRefs = (id: string) => {
  if (!relayRefCounts.has(id)) relayRefCounts.set(id, { meter: 0, clip: 0 });
  return relayRefCounts.get(id)!;
};
vi.mock('../services/meter-relay.js', () => ({
  startMeterRelay: (id: string) => { relayRefs(id).meter++; },
  stopMeterRelay: (id: string) => { if (relayRefs(id).meter > 0) relayRefs(id).meter--; },
  forceStopMeterRelay: (id: string) => { relayRefs(id).meter = 0; },
  reconcileMeterRelay: (id: string, _flow: string, _block: string, _loud: unknown, count: number) => { if (count > 0) relayRefs(id).meter = count; },
}));
vi.mock('../services/clip-relay.js', () => ({
  startClipRelay: (id: string) => { relayRefs(id).clip++; },
  stopClipRelay: (id: string) => { if (relayRefs(id).clip > 0) relayRefs(id).clip--; },
  forceStopClipRelay: (id: string) => { relayRefs(id).clip = 0; },
  reconcileClipRelay: (id: string, _flow: string, _blocks: Map<string, string>, count: number) => { if (count > 0) relayRefs(id).clip = count; },
}));

const FLOW = 'flow-watch-only';
const FLOW_B = 'flow-watch-only-b';
const AUDIO_BLOCK = 'b-audio-mixer-0';
const MIXER_BLOCK = 'b-video-mixer-0';

const writes: Array<{ method: string; url: string }> = [];
// ch1 starts off program at half level; ch2 is routed to main. Writes merge in.
const INITIAL_AUDIO_PROPS = { ch1_fader: 0.5, ch2_fader: 1.0, main_fader: 1.0, ch1_to_main: false, ch2_to_main: true };
let audioProps: Record<string, unknown> = { ...INITIAL_AUDIO_PROPS };
// Set to hold back the next flow fetch, leaving a connect mid-sync until released.
let holdNextFlowGet = false;
let releaseFlowGet: (() => void) | null = null;
// For the next audio-property write: apply it but hold the reply, or fail it.
let holdNextPatchReply = false;
let releasePatchReply: (() => void) | null = null;
let failNextPatch = false;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const url = req.url ?? '';
    if (req.method !== 'GET') writes.push({ method: req.method ?? '', url });
    const flowGet = req.method === 'GET' ? [FLOW, FLOW_B].find((f) => url === `/api/flows/${f}`) : undefined;
    if (flowGet) {
      const send = () => res.end(JSON.stringify({
        flow: {
          id: flowGet,
          blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }],
        },
      }));
      if (holdNextFlowGet) {
        holdNextFlowGet = false;
        releaseFlowGet = send;
      } else {
        send();
      }
      return;
    }
    if (url === `/api/flows/${FLOW}/blocks/${AUDIO_BLOCK}/properties`) {
      if (req.method !== 'GET' && failNextPatch) {
        failNextPatch = false;
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (req.method !== 'GET') {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { properties?: Record<string, unknown> };
        Object.assign(audioProps, body.properties ?? {});
      }
      const reply = JSON.stringify({ block_id: AUDIO_BLOCK, properties: { ...audioProps }, rejected: {} });
      if (req.method !== 'GET' && holdNextPatchReply) {
        holdNextPatchReply = false;
        releasePatchReply = () => res.end(reply);
        return;
      }
      res.end(reply);
      return;
    }
    res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

const { buildServer } = await import('../server.js');
const { broadcast, getSubscriberCount } = await import('../services/tally.service.js');
const { reinitConnectedControllers, clearAudioState } = await import('../ws/controller.js');

function makeProductionDoc(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    _rev: '1-abc',
    type: 'production',
    name: 'Watch-only Test',
    status: 'active',
    stromFlowId: FLOW,
    audioMixerBlockId: AUDIO_BLOCK,
    mixerBlockId: MIXER_BLOCK,
    sources: [],
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    pipeline: { stromConfig: null, status: 'running' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let app: FastifyInstance;

async function startApp(): Promise<void> {
  writes.length = 0;
  audioProps = { ...INITIAL_AUDIO_PROPS };
  holdNextPatchReply = false;
  releasePatchReply = null;
  failNextPatch = false;
  notifySubscriberJoin.mockClear();
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
}

interface Client {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

/** Opens a controller socket and resolves once the connect snapshot has ended. */
async function connect(productionId: string, query = ''): Promise<Client> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller${query}`);
  const messages: Array<Record<string, unknown>> = [];
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(msg);
      if (msg.type === 'SNAPSHOT_END') resolve();
    });
    ws.on('close', () => resolve());
  });
  return { ws, messages, closed };
}

/** Opens a controller socket without waiting for the connect snapshot. */
function open(productionId: string): WebSocket {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  ws.on('error', () => {});
  return ws;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const audioInitWrites = () =>
  writes.filter((w) => w.method === 'PATCH' && w.url === `/api/flows/${FLOW}/blocks/${AUDIO_BLOCK}/properties`);

afterEach(async () => {
  await app.close();
});

describe('watch-only controller connection', () => {
  it('does not run first-connect audio init; the first operator connect does', async () => {
    const id = 'prod-watch-init';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    expect(watcher.messages.map((m) => m.type)).toEqual(expect.arrayContaining(['HELLO', 'TALLY', 'PIP_STATE', 'SNAPSHOT_END']));
    expect(audioInitWrites()).toHaveLength(0);
    // With no registry yet, mute state is read from Strom's routing.
    const muteOf = (ch: string) => watcher.messages.find((m) => m.type === 'AUDIO_STATE' && m.elementId === ch && m.property === 'mute');
    expect(muteOf('ch1')).toMatchObject({ value: true });
    expect(muteOf('ch2')).toMatchObject({ value: false });

    // A second watcher still does not init.
    const watcher2 = await connect(id, '?mode=watch');
    expect(audioInitWrites()).toHaveLength(0);

    const operator = await connect(id);
    expect(audioInitWrites()).toHaveLength(1);

    watcher.ws.close();
    watcher2.ws.close();
    operator.ws.close();
  });

  it('is not counted as an operator and does not reset the idle timer', async () => {
    const id = 'prod-watch-count';
    productionDocs.set(id, makeProductionDoc(id, { stromFlowId: undefined }));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    expect(getSubscriberCount(id)).toBe(0);
    expect(notifySubscriberJoin).not.toHaveBeenCalled();
    const res = await app.inject({ method: 'GET', url: `/api/v1/productions/${id}/controllers` });
    expect(res.json()).toEqual({ count: 0, watchers: 1 });

    const operator = await connect(id);
    expect(getSubscriberCount(id)).toBe(1);
    expect(notifySubscriberJoin).toHaveBeenCalledWith(id);
    const res2 = await app.inject({ method: 'GET', url: `/api/v1/productions/${id}/controllers` });
    expect(res2.json()).toEqual({ count: 1, watchers: 1 });

    watcher.ws.close();
    operator.ws.close();
  });

  it('receives broadcasts', async () => {
    const id = 'prod-watch-broadcast';
    productionDocs.set(id, makeProductionDoc(id, { stromFlowId: undefined }));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    broadcast(id, { type: 'TALLY', pgm: 'input1', pvw: 'input2' });
    await waitFor(() => watcher.messages.some((m) => m.type === 'TALLY' && m.pgm === 'input1'));
    watcher.ws.close();
  });

  it('rejects commands with NACK (cmdId) or ERROR, and they have no effect', async () => {
    const id = 'prod-watch-commands';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    writes.length = 0;
    watcher.ws.send(JSON.stringify({ type: 'CUT', mixerInput: 'input1', cmdId: 'c1' }));
    watcher.ws.send(JSON.stringify({ type: 'KEEP_ALIVE' }));
    await waitFor(() => watcher.messages.filter((m) => m.type === 'NACK' || m.type === 'ERROR').length >= 2);

    expect(watcher.messages.find((m) => m.type === 'NACK')).toMatchObject({ cmdId: 'c1', error: expect.stringMatching(/watch-only/i) });
    expect(watcher.messages.find((m) => m.type === 'ERROR')).toMatchObject({ error: expect.stringMatching(/watch-only/i) });
    expect(watcher.messages.some((m) => m.type === 'ACK')).toBe(false);
    expect(writes).toHaveLength(0);
    expect(notifySubscriberJoin).not.toHaveBeenCalled();
    watcher.ws.close();
  });

  it('leaves the persisted PiP layout for the operator connect to push to Strom', async () => {
    const id = 'prod-watch-pip';
    const pipConfigs = [{ bg: 0, zones: [], transforms: {} }];
    productionDocs.set(id, makeProductionDoc(id, { pipConfigs }));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    expect(watcher.messages.find((m) => m.type === 'PIP_STATE')).toMatchObject({ pips: pipConfigs });
    const pipWrites = () => writes.filter((w) => w.url.includes(`/blocks/${MIXER_BLOCK}/`) && w.url.includes('pip'));
    expect(pipWrites()).toHaveLength(0);

    const operator = await connect(id);
    expect(pipWrites().length).toBeGreaterThan(0);

    watcher.ws.close();
    operator.ws.close();
  });

  it('closes on an unknown mode instead of falling back to an operator connection', async () => {
    const id = 'prod-watch-unknown-mode';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const client = await connect(id, '?mode=wacth');
    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([expect.objectContaining({ type: 'ERROR', error: expect.stringMatching(/unknown controller mode/i) })]);
    expect(audioInitWrites()).toHaveLength(0);
    expect(getSubscriberCount(id)).toBe(0);
  });

  it('rejects a query key confusable with `mode` (case variant / bracket array) instead of opening an operator connection', async () => {
    const id = 'prod-watch-confusable-key';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    // `?Mode=watch` (key case) must not silently become an operator connection.
    const miscased = await connect(id, '?Mode=watch');
    expect(await miscased.closed).toBe(1008);
    expect(miscased.messages).toEqual([
      expect.objectContaining({ type: 'ERROR', error: expect.stringMatching(/ambiguous controller mode query key/i) }),
    ]);

    // `?mode[]=watch` (bracket array syntax) is likewise rejected.
    const bracketed = await connect(id, '?mode%5B%5D=watch');
    expect(await bracketed.closed).toBe(1008);
    expect(bracketed.messages).toEqual([
      expect.objectContaining({ type: 'ERROR', error: expect.stringMatching(/ambiguous controller mode query key/i) }),
    ]);

    // Neither confusable key ran first-connect audio init or counted as an operator.
    expect(audioInitWrites()).toHaveLength(0);
    expect(getSubscriberCount(id)).toBe(0);
  });

  it('leaves a genuinely unrelated query param (cache-buster) working as an operator connection', async () => {
    const id = 'prod-watch-unrelated-key';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    // An unrelated param must be ignored: the connection proceeds as an operator
    // (first-connect audio init runs) and is counted.
    const operator = await connect(id, '?cb=123');
    expect(operator.messages.map((m) => m.type)).toEqual(expect.arrayContaining(['HELLO', 'SNAPSHOT_END']));
    expect(audioInitWrites()).toHaveLength(1);
    expect(getSubscriberCount(id)).toBe(1);
    expect(notifySubscriberJoin).toHaveBeenCalledWith(id);

    operator.ws.close();
  });

  it('does not re-init on reactivation when only watchers are connected', async () => {
    const id = 'prod-watch-reinit';
    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    clearAudioState(id); // deactivate
    await reinitConnectedControllers(id);
    expect(audioInitWrites()).toHaveLength(0);
    expect(relayRefs(id)).toEqual({ meter: 0, clip: 0 });
    watcher.ws.close();
  });

  it('releases relay refs that reactivation took for an operator that stayed open', async () => {
    const id = 'prod-watch-reinit-refs';
    // Connects before the production has a flow, so the connect itself holds no relay refs.
    productionDocs.set(id, makeProductionDoc(id, { stromFlowId: undefined }));
    await startApp();

    const operator = await connect(id);
    const watcher = await connect(id, '?mode=watch');
    expect(relayRefs(id)).toEqual({ meter: 0, clip: 0 });

    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await reinitConnectedControllers(id);
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });
    // A second pass on the same flow does not take another ref.
    await reinitConnectedControllers(id);
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    operator.ws.close();
    await waitFor(() => getSubscriberCount(id) === 0);
    expect(relayRefs(id)).toEqual({ meter: 0, clip: 0 });
    watcher.ws.close();
  });

  it('a watcher closing does not release the operator\'s relay refs', async () => {
    const id = 'prod-watch-close-refs';
    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await startApp();

    const operator = await connect(id);
    await waitFor(() => relayRefs(id).meter === 1 && relayRefs(id).clip === 1);
    const watcher = await connect(id, '?mode=watch');
    watcher.ws.close();
    await watcher.closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    operator.ws.close();
    await waitFor(() => relayRefs(id).meter === 0 && relayRefs(id).clip === 0);
  });

  it('an operator that closes mid-connect takes no relay refs', async () => {
    const id = 'prod-watch-early-close';
    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await startApp();

    const operator = await connect(id);
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    holdNextFlowGet = true;
    const leaving = open(id);
    await waitFor(() => releaseFlowGet !== null);
    leaving.close();
    await waitFor(() => getSubscriberCount(id) === 1);
    releaseFlowGet!();
    releaseFlowGet = null;
    await new Promise((r) => setTimeout(r, 150));
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    operator.ws.close();
    await waitFor(() => relayRefs(id).meter === 0 && relayRefs(id).clip === 0);
  });

  it('an operator mid-connect when reactivation re-init runs takes one relay ref, not two', async () => {
    const id = 'prod-watch-reinit-mid-connect';
    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await startApp();

    holdNextFlowGet = true;
    const operator = open(id);
    const snapshotEnd = new Promise<void>((resolve) => operator.on('message', (data) => {
      if ((JSON.parse(data.toString()) as { type?: string }).type === 'SNAPSHOT_END') resolve();
    }));
    await waitFor(() => releaseFlowGet !== null);
    clearAudioState(id); // deactivate
    await reinitConnectedControllers(id);
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });
    releaseFlowGet!();
    releaseFlowGet = null;
    await snapshotEnd;
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    operator.close();
    await waitFor(() => getSubscriberCount(id) === 0);
    expect(relayRefs(id)).toEqual({ meter: 0, clip: 0 });
  });

  it('an operator mid-connect on a flow that is replaced before its relay starts takes one relay ref, not two', async () => {
    const id = 'prod-watch-reinit-stale-flow';
    productionDocs.set(id, makeProductionDoc(id, { clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await startApp();

    holdNextFlowGet = true;
    const operator = open(id);
    const snapshotEnd = new Promise<void>((resolve) => operator.on('message', (data) => {
      if ((JSON.parse(data.toString()) as { type?: string }).type === 'SNAPSHOT_END') resolve();
    }));
    await waitFor(() => releaseFlowGet !== null);
    clearAudioState(id); // deactivate
    productionDocs.set(id, makeProductionDoc(id, { stromFlowId: FLOW_B, clipPlayerBlockIds: { clip1: 'b-clip-0' } }));
    await reinitConnectedControllers(id);
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });
    releaseFlowGet!();
    releaseFlowGet = null;
    await snapshotEnd;
    expect(relayRefs(id)).toEqual({ meter: 1, clip: 1 });

    operator.close();
    await waitFor(() => getSubscriberCount(id) === 0);
    expect(relayRefs(id)).toEqual({ meter: 0, clip: 0 });
  });

  it('tells a watcher that connected first about the operator connect\'s audio reset', async () => {
    const id = 'prod-watch-reset-broadcast';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    const latest = (ch: string, property: string) =>
      [...watcher.messages].reverse().find((m) => m.type === 'AUDIO_STATE' && m.elementId === ch && m.property === property)?.value;
    expect({ mute: latest('ch1', 'mute'), volume: latest('ch1', 'volume') }).toEqual({ mute: true, volume: 0.5 });

    const operator = await connect(id);
    await waitFor(() => latest('ch1', 'mute') === false);
    expect({ mute: latest('ch1', 'mute'), volume: latest('ch1', 'volume') }).toEqual({ mute: false, volume: 1.0 });
    expect(latest('main', 'volume')).toBe(1.0);

    watcher.ws.close();
    operator.ws.close();
  });

  it('reports a fader moved during the first operator\'s init write at its new level', async () => {
    const id = 'prod-watch-reset-race';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    holdNextPatchReply = true;
    const first = open(id);
    await waitFor(() => releasePatchReply !== null);
    const second = await connect(id);
    second.ws.send(JSON.stringify({ type: 'AUDIO_SET', elementId: 'ch2', property: 'volume', value: 0.3 }));
    await waitFor(() => audioProps.ch2_fader === 0.3);
    releasePatchReply!();
    await new Promise((r) => setTimeout(r, 150));

    const latest = (m: Array<Record<string, unknown>>) =>
      [...m].reverse().find((x) => x.type === 'AUDIO_STATE' && x.elementId === 'ch2' && x.property === 'volume')?.value;
    expect(latest(second.messages)).toBe(0.3);
    first.close();
    second.ws.close();
  });

  it('does not broadcast a reset that Strom failed to apply', async () => {
    const id = 'prod-watch-reset-failed';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const watcher = await connect(id, '?mode=watch');
    failNextPatch = true;
    const operator = await connect(id);
    await new Promise((r) => setTimeout(r, 50));
    const ch1 = watcher.messages.filter((m) => m.type === 'AUDIO_STATE' && m.elementId === 'ch1');
    expect(ch1.map((m) => [m.property, m.value])).toEqual([['volume', 0.5], ['mute', true]]);

    watcher.ws.close();
    operator.ws.close();
  });

  it('does not clear audio state when it connects on a changed flow', async () => {
    const id = 'prod-watch-flow-change';
    productionDocs.set(id, makeProductionDoc(id));
    await startApp();

    const operator = await connect(id);
    expect(audioInitWrites()).toHaveLength(1);
    operator.ws.close();

    // The production now points at another flow; a watcher arriving first must
    // leave the registries and the recorded flow alone.
    productionDocs.set(id, makeProductionDoc(id, { stromFlowId: 'flow-other' }));
    const watcher = await connect(id, '?mode=watch');
    productionDocs.set(id, makeProductionDoc(id));
    const operator2 = await connect(id);
    expect(audioInitWrites()).toHaveLength(1);

    watcher.ws.close();
    operator2.ws.close();
  });
});

