/**
 * Strom answers PATCH /api/flows/{flow}/blocks/{block}/properties with 200 even
 * when it refuses some properties, listing them under `rejected`. A refused key
 * must count as a failed write: the StromClient throws, and each controller
 * caller handles that the way it handles an HTTP error.
 *
 * A throwaway Strom serves one flow with a two-channel builtin.mixer and answers
 * block-property PATCHes per `patchMode`. The real controller plugin runs on a
 * listening Fastify server and is driven over a real `ws` client, because the
 * first-connect channel reset and the reconnect restore live in the connect
 * handler. CouchDB is mocked.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type MockInstance } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';

const docs = new Map<string, Record<string, unknown>>();
const mockGet = vi.fn(async (id: string) => {
  const doc = docs.get(id);
  if (!doc) throw Object.assign(new Error('not found'), { statusCode: 404 });
  return doc;
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: mockGet, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getOutputsDb: () => ({ get: mockGet, find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
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

vi.mock('../services/meter-relay.js', () => ({
  startMeterRelay: vi.fn(),
  stopMeterRelay: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Throwaway Strom
// ---------------------------------------------------------------------------

const FLOW_ID = 'flow-rejected';
const AUDIO_BLOCK = 'mixer1';

/**
 * What the block-properties PATCH answers: apply all, refuse some keys (200), or
 * fail with `status` (default 500). `when` limits a refusal or failure to matching requests.
 * `omitFromReply` leaves the refused keys out of the reply's `properties`;
 * `listUnwritten` lists every key in `keys` as refused, written or not;
 * `applied` makes a 500 land the write first, like a reply lost after Strom acted.
 */
type When = (written: Record<string, unknown>) => boolean;
type PatchMode =
  | { kind: 'ok' }
  | { kind: 'reject'; keys: string[]; when?: When; omitFromReply?: boolean; listUnwritten?: boolean }
  | { kind: 'httpError'; when?: When; applied?: boolean; status?: number };
let patchMode: PatchMode = { kind: 'ok' };
/** Reply delay per request; Strom's state changes on receipt unless `patchAppliesLate` matches. */
let patchDelayMs: (written: Record<string, unknown>) => number = () => 0;
/** Writes Strom applies only when it replies, like one queued behind a stall. */
let patchAppliesLate: When = () => false;
/** Strom's view of the mixer's current values, returned by GET and PATCH. */
let stromProps: Record<string, unknown> = {};
const patches: Array<Record<string, unknown>> = [];
/** Makes GET of the mixer's properties fail with 500. */
let blockGetFails = false;
/** Reply delay for GET of the mixer's properties, and how many have arrived (connects read it too). */
let blockGetDelayMs = 0;
let blockGets = 0;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as { properties?: Record<string, unknown> }) : {};
    const url = req.url ?? '';
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (req.method === 'GET' && url === `/api/flows/${FLOW_ID}`) {
      return send(200, {
        flow: {
          id: FLOW_ID,
          blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }],
        },
      });
    }
    const blockProps = `/api/flows/${FLOW_ID}/blocks/${AUDIO_BLOCK}/properties`;
    if (req.method === 'GET' && url === blockProps) {
      blockGets++;
      if (blockGetFails) return send(500, { error: 'boom' });
      const properties = { ...stromProps };
      return void setTimeout(() => send(200, { block_id: AUDIO_BLOCK, properties, rejected: {} }), blockGetDelayMs);
    }
    if (req.method === 'PATCH' && url === blockProps) {
      const written = body.properties ?? {};
      patches.push(written);
      const delay = patchDelayMs(written);
      if (patchMode.kind === 'httpError' && (patchMode.when?.(written) ?? true)) {
        if (patchMode.applied) Object.assign(stromProps, written);
        return void setTimeout(() => send(patchMode.kind === 'httpError' ? patchMode.status ?? 500 : 500, { error: 'boom' }), delay);
      }
      const refused = patchMode.kind === 'reject' && (patchMode.when?.(written) ?? true) ? patchMode.keys : [];
      const rejected: Record<string, string> = {};
      const toApply: Record<string, unknown> = {};
      for (const key of Object.keys(written)) {
        if (refused.includes(key)) rejected[key] = 'property is not live (requires flow restart)';
        else toApply[key] = written[key];
      }
      if (patchAppliesLate(written)) {
        return void setTimeout(() => {
          Object.assign(stromProps, toApply);
          send(200, { block_id: AUDIO_BLOCK, properties: { ...stromProps }, rejected });
        }, delay);
      }
      Object.assign(stromProps, toApply);
      if (patchMode.kind === 'reject' && patchMode.listUnwritten) {
        for (const key of refused) rejected[key] ??= 'property is not live (requires flow restart)';
      }
      const properties = { ...stromProps };
      if (patchMode.kind === 'reject' && patchMode.omitFromReply) for (const key of Object.keys(rejected)) delete properties[key];
      const reply = { block_id: AUDIO_BLOCK, properties, rejected };
      return void setTimeout(() => send(200, reply), delay);
    }
    send(200, {});
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
const STROM_URL = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
process.env['STROM_URL'] = STROM_URL;
// Short limits so the timeout paths run within a test.
process.env['STROM_BLOCK_PROPERTIES_TIMEOUT_MS'] = '1500';
process.env['MUTE_TIMEOUT_RECHECK_MS'] = '600';

// Imported after STROM_URL is set so config picks up the throwaway server.
const { StromClient, StromClientError, StromPropertiesRejectedError } = await import('../lib/strom.js');
const { buildServer } = await import('../server.js');
const { clearAudioState } = await import('../ws/controller.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let prodSeq = 0;

/** A fresh production id per test: the controller's registries are module state keyed by it. */
function newProduction(overrides: Record<string, unknown> = {}): string {
  const id = `prod-rejected-${++prodSeq}`;
  docs.set(id, {
    _id: id,
    _rev: '1-abc',
    type: 'production',
    name: 'Rejected',
    status: 'active',
    stromFlowId: FLOW_ID,
    audioMixerBlockId: AUDIO_BLOCK,
    sources: [],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return id;
}

type Frame = Record<string, unknown>;

interface Client {
  ws: WebSocket;
  frames: Frame[];
  send: (msg: Frame) => void;
  close: () => void;
}

/** Connect and wait until the connect-time audio restore has reached ch2. */
async function connect(productionId: string): Promise<Client> {
  const { port } = app.server.address() as AddressInfo;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/productions/${productionId}/controller`);
  const frames: Frame[] = [];
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString()) as Frame); } catch { /* ignore */ }
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => resolve());
  });
  await waitFor(() => frames.some((f) => f.type === 'AUDIO_STATE' && f.elementId === 'ch2' && f.property === 'mute'));
  return { ws, frames, send: (msg) => ws.send(JSON.stringify(msg)), close: () => ws.close() };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

function audioStates(frames: Frame[], elementId: string, property: 'mute' | 'volume'): unknown[] {
  return frames
    .filter((f) => f.type === 'AUDIO_STATE' && f.elementId === elementId && f.property === property)
    .map((f) => f.value);
}

let warn: MockInstance<typeof console.warn>;

beforeAll(async () => {
  app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  stromServer.close();
});

beforeEach(() => {
  patchMode = { kind: 'ok' };
  patchDelayMs = () => 0;
  patchAppliesLate = () => false;
  stromProps = { ch1_fader: 0.4, ch2_fader: 0.7, main_fader: 0.9 };
  patches.length = 0;
  blockGetFails = false;
  blockGetDelayMs = 0;
  blockGets = 0;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

// ---------------------------------------------------------------------------
// StromClient
// ---------------------------------------------------------------------------

describe('StromClient.flows.updateBlockProperties', () => {
  const client = () => new StromClient({ baseUrl: STROM_URL });

  it('throws StromPropertiesRejectedError naming each refused key and its reason', async () => {
    patchMode = { kind: 'reject', keys: ['ch1_to_main'] };
    const err = await client().flows
      .updateBlockProperties(FLOW_ID, AUDIO_BLOCK, { properties: { ch1_to_main: false, ch2_fader: 0.5 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StromPropertiesRejectedError);
    const rejectedErr = err as InstanceType<typeof StromPropertiesRejectedError>;
    expect(rejectedErr.rejected).toEqual({ ch1_to_main: 'property is not live (requires flow restart)' });
    expect(rejectedErr.message).toContain('ch1_to_main');
    expect(rejectedErr.current).toMatchObject({ ch2_fader: 0.5 });
  });

  it('ignores a refused key the request did not write', async () => {
    patchMode = { kind: 'reject', keys: ['ch1_to_main'], listUnwritten: true };
    const res = await client().flows.updateBlockProperties(FLOW_ID, AUDIO_BLOCK, { properties: { ch2_fader: 0.5 } });
    expect(res.properties).toMatchObject({ ch2_fader: 0.5 });
  });

  it('gives up on a write Strom does not answer in time', async () => {
    patchDelayMs = () => 500;
    const slow = new StromClient({ baseUrl: STROM_URL, blockPropertiesTimeoutMs: 100 });
    const err = await slow.flows
      .updateBlockProperties(FLOW_ID, AUDIO_BLOCK, { properties: { ch2_fader: 0.5 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StromClientError);
    expect((err as InstanceType<typeof StromClientError>).status).toBe(0);
    expect(String(err)).toContain('did not answer within 100 ms');
  });

  it('resolves when nothing written was refused', async () => {
    const res = await client().flows.updateBlockProperties(FLOW_ID, AUDIO_BLOCK, { properties: { ch2_fader: 0.5 } });
    expect(res.rejected).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// AUDIO_SET mute: error reply, sender UI put back, mute registry unchanged
// ---------------------------------------------------------------------------

describe('AUDIO_SET mute when Strom does not apply the routing', () => {
  it.each<[string, PatchMode]>([
    ['200 with ch1_to_main in rejected', { kind: 'reject', keys: ['ch1_to_main'] }],
    ['HTTP 500', { kind: 'httpError' }],
  ])('%s: sender gets ERROR + its mute put back, nobody sees the mute, registry unchanged', async (_label, mode) => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchMode = mode;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(100);

    const error = a.frames.find((f) => f.type === 'ERROR');
    if (mode.kind === 'reject') expect(error?.error).toContain('ch1_to_main');
    // The sender's optimistic toggle is put back; no client sees ch1 muted.
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'ch1', 'mute')).toEqual([false]);
    expect(audioStates(a.frames, 'ch1', 'mute')).not.toContain(true);
    expect(audioStates(b.frames, 'ch1', 'mute')).not.toContain(true);

    // A later client restores from the mute registry: still unmuted.
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close(); c.close();
  });

  it('NACKs a command carrying cmdId', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    patchMode = { kind: 'reject', keys: ['ch1_to_main'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true, cmdId: 'c1' });
    await waitFor(() => a.frames.some((f) => f.type === 'NACK'));
    expect(a.frames.find((f) => f.type === 'NACK')).toMatchObject({ cmdId: 'c1' });
    expect(String(a.frames.find((f) => f.type === 'NACK')?.error)).toContain('ch1_to_main');
    a.close();
  });

  it('control: an applied mute is broadcast and kept in the registry', async () => {
    const prod = newProduction();
    const a = await connect(prod);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true));
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    expect(a.frames.some((f) => f.type === 'ERROR')).toBe(false);
    a.close(); c.close();
  });

  it('a refused return-mirror send alone keeps the mute and warns the sender', async () => {
    const prod = newProduction({
      returnBuses: [{ mixerInput: 'video_in_1', auxBus: 1, ownChannel: 1, mode: 'program' }],
    });
    const a = await connect(prod);
    patchMode = { kind: 'reject', keys: ['ch1_aux1_level'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true));
    expect(patches.at(-1)).toMatchObject({ ch1_to_main: false, ch1_aux1_level: expect.any(Number) });
    // The sender is told the guest return still carries the channel.
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    expect(String(a.frames.find((f) => f.type === 'ERROR')?.error)).toMatch(/guest return still carries it.*ch1_aux1_level/);

    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); c.close();
  });

  it('a refused return-mirror send on an unmute says the guest return was not reopened', async () => {
    const prod = newProduction({
      returnBuses: [{ mixerInput: 'video_in_1', auxBus: 1, ownChannel: 1, mode: 'program' }],
    });
    const a = await connect(prod);
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true));
    patchMode = { kind: 'reject', keys: ['ch1_aux1_level'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    expect(String(a.frames.find((f) => f.type === 'ERROR')?.error)).toMatch(/live on program, but a guest return did not reopen it/);
    a.close();
  });

  it('a 404 from Strom counts as not applied, even when the read-back fails too', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    const bBefore = b.frames.length;
    patchMode = { kind: 'httpError', status: 404 };
    blockGetFails = true;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(100);
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'ch1', 'mute')).toEqual([false]);
    expect(audioStates(b.frames.slice(bBefore), 'ch1', 'mute')).toEqual([]);

    blockGetFails = false;
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close(); c.close();
  });
});

// ---------------------------------------------------------------------------
// AUDIO_SET volume: a refused fader puts the cache and UIs back on Strom's level
// ---------------------------------------------------------------------------

describe('AUDIO_SET volume when Strom refuses the fader', () => {
  it('broadcasts and caches Strom\'s actual level, not the refused one', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    patchMode = { kind: 'reject', keys: ['ch1_fader'] };
    stromProps['ch1_fader'] = 0.4;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.9 });
    await waitFor(() => patches.some((p) => p['ch1_fader'] === 0.9));
    await waitFor(() => audioStates(a.frames, 'ch1', 'volume').at(-1) === 0.4);

    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'volume')).toEqual([0.4]);
    a.close(); c.close();
  });
});

// ---------------------------------------------------------------------------
// First connect: the channel reset keeps what applied, forgets refused faders
// ---------------------------------------------------------------------------

describe('AUDIO_SET races with a slow Strom', () => {
  it('a refused fader does not overwrite a newer fader value that applied', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    stromProps['ch1_fader'] = 0.4;
    patchMode = { kind: 'reject', keys: ['ch1_fader'], when: (w) => w['ch1_fader'] === 0.5 };
    patchDelayMs = (w) => (w['ch1_fader'] === 0.5 ? 400 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.5 });
    await waitFor(() => patches.some((p) => p['ch1_fader'] === 0.5));
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.6 });
    await waitFor(() => patches.some((p) => p['ch1_fader'] === 0.6));
    await settle(500);

    expect(stromProps['ch1_fader']).toBe(0.6);
    expect(audioStates(a.frames, 'ch1', 'volume').at(-1)).toBe(0.6);
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'volume')).toEqual([0.6]);
    a.close(); c.close();
  });

  it('a RETURN_SET during an in-flight mute keeps the muted channel closed in the return', async () => {
    const prod = newProduction({
      sources: [{ sourceId: 'guest-1', mixerInput: 'video_in_1', returnFeed: { synced: 'program' } }],
      returnBuses: [{ mixerInput: 'video_in_1', auxBus: 1, ownChannel: 1, mode: 'program' }],
    });
    const a = await connect(prod);
    patchDelayMs = (w) => ('ch1_to_main' in w ? 300 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    a.send({ type: 'RETURN_SET', mixerInput: 'video_in_1', mode: 'program' });
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true));
    await settle(100);

    expect(stromProps['ch1_to_main']).toBe(false);
    expect(stromProps['ch1_aux1_level']).toBe(0);
    a.close();
  });

  it('a refused main mute resyncs the sender to Strom\'s main_mute, not a guess', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    a.send({ type: 'AUDIO_SET', elementId: 'main', property: 'mute', value: true });
    await waitFor(() => audioStates(a.frames, 'main', 'mute').includes(true));
    stromProps['main_mute'] = true;
    patchMode = { kind: 'reject', keys: ['main_mute'] };

    a.send({ type: 'AUDIO_SET', elementId: 'main', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(50);
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'main', 'mute')).toEqual([true]);
    a.close();
  });

  it('a refused channel mute with no mute registry resyncs to the channel\'s routing, not main_mute', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    clearAudioState(prod); // deactivate or idle stop while the tab stays open
    stromProps['main_mute'] = true;
    patchMode = { kind: 'reject', keys: ['ch1_to_main'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(50);
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'ch1', 'mute')).toEqual([false]);
    a.close();
  });

  it('a slow refused mute does not undo a later mute that applied', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    let n = 0;
    patchMode = { kind: 'reject', keys: ['ch1_to_main'], when: (w) => 'ch1_to_main' in w && ++n === 1 };
    // Only the first write is slow (the delay is computed before `when` counts it).
    patchDelayMs = (w) => ('ch1_to_main' in w && n === 0 ? 400 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(b.frames, 'ch1', 'mute').includes(true));
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));

    expect(stromProps['ch1_to_main']).toBe(false);
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); b.close(); c.close();
  });

  it('two overlapping mutes that both fail leave the registry unmuted', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchMode = { kind: 'httpError' };
    // The second write fails last, after the first has already failed.
    patchDelayMs = (w) => ('ch1_to_main' in w ? 200 * patches.filter((p) => 'ch1_to_main' in p).length : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    // The last write to finish reports the error, after the registry has settled.
    await waitFor(() => b.frames.some((f) => f.type === 'ERROR'));

    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close(); c.close();
  });

  it('a refused fader resyncs even after a newer move back to the same level', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    stromProps['ch1_fader'] = 0.4;
    let n = 0;
    patchMode = { kind: 'reject', keys: ['ch1_fader'], when: (w) => w['ch1_fader'] === 0.5 && ++n === 1 };
    // Only the first 0.5 is slow, so the second 0.5 applies before the refusal returns.
    patchDelayMs = (w) => (w['ch1_fader'] === 0.5 && n === 0 ? 600 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.5 });
    await waitFor(() => patches.some((p) => p['ch1_fader'] === 0.5));
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.6 });
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.5 });
    await waitFor(() => patches.filter((p) => p['ch1_fader'] === 0.5).length === 2);
    await settle(700);

    expect(stromProps['ch1_fader']).toBe(0.5);
    expect(audioStates(a.frames, 'ch1', 'volume').at(-1)).toBe(0.5);
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'volume')).toEqual([0.5]);
    a.close(); c.close();
  });
});

describe('AUDIO_SET mute when the outcome is unclear', () => {
  it('an unmute Strom applied but answered with an error shows live, with no error', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(b.frames, 'ch1', 'mute').includes(true));
    patchMode = { kind: 'httpError', applied: true };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await waitFor(() => audioStates(b.frames, 'ch1', 'mute').at(-1) === false);
    expect(stromProps['ch1_to_main']).toBe(true);
    expect(a.frames.some((f) => f.type === 'ERROR')).toBe(false);

    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close(); c.close();
  });

  it('a failed write Strom did not apply is reported to the sender and put back', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    const bBefore = b.frames.length;
    patchMode = { kind: 'httpError' };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(50);
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'ch1', 'mute')).toEqual([false]);
    // Nothing changed for other clients, so they get no update.
    expect(audioStates(b.frames.slice(bBefore), 'ch1', 'mute')).toEqual([]);
    a.close(); b.close();
  });

  it('when Strom cannot be read back either, the change is treated as made', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    patchMode = { kind: 'httpError' };
    blockGetFails = true;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true));
    expect(a.frames.some((f) => f.type === 'ERROR')).toBe(false);

    blockGetFails = false;
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); c.close();
  });

  it('a slow mute that applies after a newer unmute failed leaves the channel shown muted', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchMode = { kind: 'httpError', when: (w) => w['ch1_to_main'] === true };
    patchDelayMs = (w) => (w['ch1_to_main'] === false ? 400 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === true));
    await waitFor(() => audioStates(b.frames, 'ch1', 'mute').at(-1) === true);
    await settle(100);

    expect(stromProps['ch1_to_main']).toBe(false);
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); b.close(); c.close();
  });

  it('a slow mute overtaken by an unmute that applied last does not leave UIs showing muted', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchDelayMs = (w) => (w['ch1_to_main'] === false ? 400 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    const bBefore = b.frames.length;
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await settle(600);

    expect(stromProps['ch1_to_main']).toBe(true);
    expect(audioStates(a.frames, 'ch1', 'mute').at(-1)).toBe(false);
    // One update, not one per write.
    expect(audioStates(b.frames.slice(bBefore), 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close();
  });

  it('the newest write is shown as soon as it applies, while an older one is still slow', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchDelayMs = (w) => (w['ch1_to_main'] === false ? 1000 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    const bBefore = b.frames.length;
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await waitFor(() => audioStates(b.frames.slice(bBefore), 'ch1', 'mute').includes(false), 500);
    a.close(); b.close();
  });

  it('an older write that finishes while a newer one is out is not shown', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    patchDelayMs = (w) => (w['ch1_to_main'] === false ? 100 : w['ch1_to_main'] === true ? 400 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => patches.some((p) => p['ch1_to_main'] === false));
    const bBefore = b.frames.length;
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await settle(600);

    expect(stromProps['ch1_to_main']).toBe(true);
    expect(audioStates(b.frames.slice(bBefore), 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close();
  });

  it('a refused command still gets its NACK when a newer write starts during the read-back', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    const c = await connect(prod);
    // a's write applies; b's overlaps it, is refused and finishes last, so it
    // reads Strom back. c's write starts during that read and is still out
    // when the read returns.
    let n = 0;
    patchMode = { kind: 'reject', keys: ['ch1_to_main'], when: () => n === 2 };
    patchDelayMs = (w) => ('ch1_to_main' in w ? [100, 300, 600][n++] ?? 0 : 0);
    blockGetDelayMs = 300;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => n === 1);
    const getsBefore = blockGets;
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false, cmdId: 'b1' });
    await waitFor(() => blockGets > getsBefore);
    c.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => b.frames.some((f) => f.type === 'NACK' && f.cmdId === 'b1'));
    a.close(); b.close(); c.close();
  });
});

describe('AUDIO_SET mute read-back', () => {
  it('a newer write that finishes during the read-back is not undone by the stale answer', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    // The mute lands but its reply is lost, so its outcome is read back slowly.
    patchMode = { kind: 'httpError', applied: true, when: (w) => w['ch1_to_main'] === false };
    blockGetDelayMs = 400;

    const getsBefore = blockGets;
    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => blockGets > getsBefore);
    b.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: false });
    await settle(700);

    expect(stromProps['ch1_to_main']).toBe(true);
    expect(audioStates(b.frames, 'ch1', 'mute').at(-1)).toBe(false);
    blockGetDelayMs = 0;
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([false]);
    a.close(); b.close(); c.close();
  });

  it('a mute Strom applies only after the time limit is still shown as made', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    const b = await connect(prod);
    // Strom applies the write at 1.7 s, after the 1.5 s limit and the first read.
    patchAppliesLate = (w) => w['ch1_to_main'] === false;
    patchDelayMs = (w) => (w['ch1_to_main'] === false ? 1700 : 0);

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => audioStates(b.frames, 'ch1', 'mute').includes(true), 3000);
    expect(a.frames.some((f) => f.type === 'ERROR')).toBe(false);
    patchDelayMs = () => 0;
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); b.close(); c.close();
  });

  it('a read-back Strom does not answer in time counts as no answer', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    patchMode = { kind: 'httpError' };
    blockGetDelayMs = 4000;

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    // Without a limit the read would hold the settle for 4 s.
    await waitFor(() => audioStates(a.frames, 'ch1', 'mute').includes(true), 2500);
    blockGetDelayMs = 0;
    a.close();
  });
});

describe('AUDIO_SET refusals settle from Strom\'s reported state', () => {
  it('a refused mute on a channel Strom already has off program records it as muted', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    stromProps['ch1_to_main'] = false; // muted in Strom, unknown to the registry
    patchMode = { kind: 'reject', keys: ['ch1_to_main'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    patchMode = { kind: 'ok' };
    const c = await connect(prod);
    expect(audioStates(c.frames, 'ch1', 'mute')).toEqual([true]);
    a.close(); c.close();
  });

  it('with no mute registry, the sender is resynced from the channel\'s routing in Strom', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    clearAudioState(prod);
    stromProps['ch1_to_main'] = false; // the channel is muted
    patchMode = { kind: 'reject', keys: ['ch1_to_main'] };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'mute', value: true });
    await waitFor(() => a.frames.some((f) => f.type === 'ERROR'));
    await settle(50);
    const afterError = a.frames.slice(a.frames.findIndex((f) => f.type === 'ERROR'));
    expect(audioStates(afterError, 'ch1', 'mute')).toEqual([true]);
    a.close();
  });

  it('a refused fader missing from the reply is read back from Strom', async () => {
    const prod = newProduction();
    const a = await connect(prod);
    stromProps['ch1_fader'] = 0.4;
    patchMode = { kind: 'reject', keys: ['ch1_fader'], omitFromReply: true };

    a.send({ type: 'AUDIO_SET', elementId: 'ch1', property: 'volume', value: 0.9 });
    await waitFor(() => audioStates(a.frames, 'ch1', 'volume').at(-1) === 0.4);
    a.close();
  });
});

describe('first-connect channel reset when Strom refuses a key', () => {
  it('reports Strom\'s level for a refused fader and unity for the rest', async () => {
    const prod = newProduction();
    patchMode = { kind: 'reject', keys: ['ch1_fader'] };
    stromProps['ch1_fader'] = 0.4;

    const a = await connect(prod);
    expect(patches[0]).toMatchObject({ ch1_fader: 1, ch2_fader: 1, main_fader: 1 });
    expect(audioStates(a.frames, 'ch1', 'volume')).toEqual([0.4]);
    expect(audioStates(a.frames, 'ch2', 'volume')).toEqual([1]);
    expect(warn.mock.calls.some((c) => c[1] instanceof StromPropertiesRejectedError)).toBe(true);
    a.close();
  });
});

// ---------------------------------------------------------------------------
// Log-only callers: a refusal takes the same path as an HTTP error
// ---------------------------------------------------------------------------

describe('log-only callers report a refusal like an HTTP error', () => {
  it.each<[string, Frame, string]>([
    ['PFL_SET', { type: 'PFL_SET', elementId: 'ch1', enabled: true }, 'ch1_pfl'],
    ['MONITOR_SET (debounced)', { type: 'MONITOR_SET', volume: 0.5, muted: false }, 'monitor_fader'],
  ])('%s logs the refused key', async (_label, msg, key) => {
    const prod = newProduction();
    const a = await connect(prod);
    patchMode = { kind: 'reject', keys: [key] };
    warn.mockClear();

    a.send(msg);
    await waitFor(() => patches.some((p) => key in p));
    await waitFor(() => warn.mock.calls.some((c) => c[1] instanceof StromPropertiesRejectedError));
    const logged = warn.mock.calls.find((c) => c[1] instanceof StromPropertiesRejectedError)!;
    expect(String((logged[1] as Error).message)).toContain(key);
    a.close();
  });
});
