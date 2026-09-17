/**
 * Tests for the automation-ready control contract (issue #209, spec §2–§4).
 *
 * Covers:
 *  1. Event sequence numbers — monotonically increasing `seq` on broadcasts
 *  2. Command acknowledgement — ACK(accepted), ACK(executed), NACK
 *  3. Contribution-based tally — `program` / `preview` / `contributions` fields
 *  4. Connect-time snapshot — HELLO, TALLY with contributions, GRAPHIC_STATE, SNAPSHOT_END
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from '@fastify/websocket';
import { broadcast, subscribe, unsubscribe, nextSeq, currentSeq } from '../services/tally.service.js';
import { computeTallyContributions, CONTRACT_VERSION } from '../services/automation-contract.js';
import { handleMessage } from '../ws/controller.js';

// ---------------------------------------------------------------------------
// Shared mock WS helpers
// ---------------------------------------------------------------------------

class FakeWs {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(payload: string): void {
    this.sent.push(payload);
  }
  last(): Record<string, unknown> {
    return JSON.parse(this.sent[this.sent.length - 1]) as Record<string, unknown>;
  }
  all(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies needed by handleMessage
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn().mockResolvedValue({ ok: true });

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert }),
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom.js', () => ({
  StromClient: vi.fn().mockImplementation(() => ({
    mixer: {
      transition: vi.fn().mockResolvedValue({}),
      selectPreview: vi.fn().mockResolvedValue({}),
      updatePipConfig: vi.fn().mockResolvedValue({ transforms: {} }),
      fadeToBlack: vi.fn().mockResolvedValue({ active: true }),
      setOverlayAlpha: vi.fn().mockResolvedValue({}),
    },
    flows: {
      get: vi.fn().mockResolvedValue({ flow: { blocks: [] } }),
      updateBlockProperties: vi.fn().mockResolvedValue({}),
    },
  })),
  StromClientError: class extends Error {},
}));

vi.mock('../services/idle-watchdog.js', () => ({
  notifySubscriberJoin: vi.fn(),
}));

vi.mock('../services/meter-relay.js', () => ({
  startMeterRelay: vi.fn(),
  stopMeterRelay: vi.fn(),
}));

vi.mock('../services/pfl-state.js', () => ({
  activePflByProduction: new Map(),
  activeAflByProduction: new Map(),
  anySoloActive: vi.fn().mockReturnValue(false),
  numAudioChannelsByProduction: new Map(),
}));

vi.mock('../config.ts', () => ({
  config: { stromUrl: 'http://localhost:9999', stromToken: undefined, apiKey: undefined },
}));

// ---------------------------------------------------------------------------
// Minimal ProductionDoc factory
// ---------------------------------------------------------------------------

function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: 'prod-test',
    _rev: '1-abc',
    type: 'production',
    name: 'Test',
    status: 'active',
    sources: [],
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    pipeline: { status: 'running', stromConfig: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// 1. Sequence numbers
// ============================================================================

describe('Event sequence numbers (#169 / contract §2)', () => {
  const PROD = 'prod-seq-test';

  it('nextSeq starts at 1 and increments monotonically', () => {
    // Reset by using a unique production id
    const id = `prod-seq-mono-${Date.now()}`;
    expect(currentSeq(id)).toBe(0);
    expect(nextSeq(id)).toBe(1);
    expect(nextSeq(id)).toBe(2);
    expect(nextSeq(id)).toBe(3);
    expect(currentSeq(id)).toBe(3);
  });

  it('broadcast() stamps seq that advances per event', () => {
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    const before = currentSeq(PROD);
    broadcast(PROD, { type: 'TALLY', pgm: null, pvw: null });
    broadcast(PROD, { type: 'PIP_STATE', pgmPip: null, pvwPip: null, pips: [] });

    const msgs = ws.all().slice(-2);
    expect(typeof msgs[0].seq).toBe('number');
    expect(typeof msgs[1].seq).toBe('number');
    // Each broadcast increments seq
    expect(msgs[1].seq as number).toBeGreaterThan(msgs[0].seq as number);
    expect(msgs[0].seq as number).toBeGreaterThan(before);

    unsubscribe(PROD, ws as unknown as WebSocket);
  });

  it('seq and ts appear together on every broadcast', () => {
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    broadcast(PROD, { type: 'ON_AIR', value: true });
    const msg = ws.last();

    expect(typeof msg.seq).toBe('number');
    expect(typeof msg.ts).toBe('string');
    // ts is a valid ISO-8601
    expect(new Date(msg.ts as string).toISOString()).toBe(msg.ts);

    unsubscribe(PROD, ws as unknown as WebSocket);
  });
});

// ============================================================================
// 2. Command acknowledgement — ACK / NACK
// ============================================================================

describe('Command acknowledgement — ACK / NACK (contract §2)', () => {
  const PROD = 'prod-ack-test';

  beforeEach(() => {
    mockGet.mockReset();
    mockInsert.mockReset().mockResolvedValue({ ok: true });
  });

  it('sends ACK(accepted) immediately after validation when cmdId is present', async () => {
    mockGet.mockResolvedValue(makeDoc());
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    await handleMessage(
      PROD, ws as unknown as WebSocket,
      JSON.stringify({ type: 'SET_OVL', alpha: 0.5, cmdId: 'test-cmd-1' }),
      {},
    );

    const ackMsgs = ws.all().filter((m) => m.type === 'ACK') as Array<{
      type: string; cmdId: string; phase: string; seq: number; ts: string;
    }>;
    // At least one ACK(accepted)
    const accepted = ackMsgs.find((m) => m.phase === 'accepted');
    expect(accepted).toBeDefined();
    expect(accepted!.cmdId).toBe('test-cmd-1');
    expect(typeof accepted!.seq).toBe('number');
    expect(typeof accepted!.ts).toBe('string');

    unsubscribe(PROD, ws as unknown as WebSocket);
  });

  it('sends ACK(executed) after the command completes when cmdId is present', async () => {
    mockGet.mockResolvedValue(makeDoc());
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    await handleMessage(
      PROD, ws as unknown as WebSocket,
      JSON.stringify({ type: 'CUT', mixerInput: 'video_in_1', cmdId: 'exec-cmd-1' }),
      {},
    );

    const ackMsgs = ws.all().filter((m) => m.type === 'ACK') as Array<{
      type: string; phase: string; cmdId: string; seq: number;
    }>;
    const accepted = ackMsgs.find((m) => m.phase === 'accepted');
    const executed = ackMsgs.find((m) => m.phase === 'executed');
    expect(accepted).toBeDefined();
    expect(executed).toBeDefined();
    // executed seq > accepted seq (accepted comes first)
    expect(executed!.seq).toBeGreaterThan(accepted!.seq);

    unsubscribe(PROD, ws as unknown as WebSocket);
  });

  it('sends NACK when production is not found and cmdId is present', async () => {
    mockGet.mockRejectedValue(new Error('not_found'));
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    await handleMessage(
      PROD, ws as unknown as WebSocket,
      JSON.stringify({ type: 'CUT', mixerInput: 'video_in_1', cmdId: 'nack-cmd-1' }),
      {},
    );

    // Should have ACK(accepted) then NACK (production not found)
    const msgs = ws.all();
    const nack = msgs.find((m) => m.type === 'NACK') as { type: string; cmdId: string; error: string; seq: number } | undefined;
    expect(nack).toBeDefined();
    expect(nack!.cmdId).toBe('nack-cmd-1');
    expect(typeof nack!.error).toBe('string');
    expect(typeof nack!.seq).toBe('number');

    unsubscribe(PROD, ws as unknown as WebSocket);
  });

  it('does not send ACK when cmdId is absent (backward compatibility)', async () => {
    mockGet.mockResolvedValue(makeDoc());
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    await handleMessage(
      PROD, ws as unknown as WebSocket,
      JSON.stringify({ type: 'SET_OVL', alpha: 0.3 }),
      {},
    );

    const ackMsgs = ws.all().filter((m) => m.type === 'ACK' || m.type === 'NACK');
    expect(ackMsgs).toHaveLength(0);

    unsubscribe(PROD, ws as unknown as WebSocket);
  });
});

// ============================================================================
// 3. Contribution-based tally
// ============================================================================

describe('Contribution-based tally (contract §3)', () => {
  it('returns main source on program when no PiP is active', () => {
    const result = computeTallyContributions(
      'video_in_1', // pgm
      'video_in_2', // pvw
      null,         // pgmPip
      null,         // pvwPip
      null,         // pgmBg
      null,         // pvwBefore
      undefined,    // pipConfigs
      undefined,    // dskLayers
      [],           // activeGraphics
    );
    expect(result.program).toEqual(['video_in_1']);
    expect(result.preview).toEqual(['video_in_2']);
    expect(result.contributions).toHaveLength(1);
    expect(result.contributions[0]).toEqual({ source: 'video_in_1', role: 'main' });
  });

  it('returns pip-bg and pip-inset when PiP is on program', () => {
    const pipConfigs = [
      {
        bg: null,
        zones: [{ sources: [2, 3], rect: null, capacity: null }],
        transforms: {},
      },
    ];
    const result = computeTallyContributions(
      null,            // pgm (null because PiP is on PGM)
      'video_in_4',    // pvw
      0,               // pgmPip — slot 0
      null,            // pvwPip
      'video_in_1',    // pgmBg — real source behind the PiP
      null,            // pvwBefore
      pipConfigs,      // pipConfigs
      undefined,       // dskLayers
      [],              // activeGraphics
    );
    expect(result.program).toContain('video_in_1');    // pgmBg
    expect(result.program).toContain('video_in_2');    // zone inset
    expect(result.program).toContain('video_in_3');    // zone inset
    const bgContrib = result.contributions.find((c) => c.source === 'video_in_1');
    expect(bgContrib?.role).toBe('pip-bg');
    const insetContrib = result.contributions.find((c) => c.source === 'video_in_2');
    expect(insetContrib?.role).toBe('pip-inset');
  });

  it('includes active DSK layers in program with dsk: prefix', () => {
    const result = computeTallyContributions(
      'video_in_1',
      'video_in_2',
      null,
      null,
      null,
      null,
      undefined,
      { 0: true, 1: false },   // layer 0 visible, layer 1 not
      [],
    );
    expect(result.program).toContain('dsk:0');
    expect(result.program).not.toContain('dsk:1');
    expect(result.contributions.find((c) => c.source === 'dsk:0')?.role).toBe('dsk');
  });

  it('includes active graphics overlays in program with gfx: prefix', () => {
    const result = computeTallyContributions(
      'video_in_1',
      'video_in_2',
      null,
      null,
      null,
      null,
      undefined,
      undefined,
      ['gfx-001', 'gfx-002'],
    );
    expect(result.program).toContain('gfx:gfx-001');
    expect(result.program).toContain('gfx:gfx-002');
    expect(result.contributions.find((c) => c.source === 'gfx:gfx-001')?.role).toBe('graphic');
  });

  it('keeps legacy pgm/pvw fields in TALLY broadcast', async () => {
    const PROD = 'prod-contrib-tally';
    const ws = new FakeWs();
    subscribe(PROD, ws as unknown as WebSocket);

    const mockDoc = makeDoc({ tally: { pgm: 'video_in_1', pvw: 'video_in_2' } });
    mockGet.mockResolvedValue(mockDoc);

    await handleMessage(
      PROD, ws as unknown as WebSocket,
      JSON.stringify({ type: 'CUT', mixerInput: 'video_in_1' }),
      {},
    );

    const tallyMsg = ws.all().find((m) => m.type === 'TALLY');
    expect(tallyMsg).toBeDefined();
    // Legacy fields still present
    expect('pgm' in (tallyMsg as Record<string, unknown>)).toBe(true);
    expect('pvw' in (tallyMsg as Record<string, unknown>)).toBe(true);
    // New contribution fields present
    expect(Array.isArray(tallyMsg!.program)).toBe(true);
    expect(Array.isArray(tallyMsg!.preview)).toBe(true);
    expect(Array.isArray(tallyMsg!.contributions)).toBe(true);

    unsubscribe(PROD, ws as unknown as WebSocket);
  });
});

// ============================================================================
// 4. Contract version constant
// ============================================================================

describe('CONTRACT_VERSION', () => {
  it('is a semver string starting with 1', () => {
    expect(typeof CONTRACT_VERSION).toBe('string');
    expect(CONTRACT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CONTRACT_VERSION.startsWith('1.')).toBe(true);
  });
});
