/**
 * The guest page on a return-only slot. Runs the script served by
 * `GET /guest/:id` in a VM with a small fake DOM; the page's fetch calls go to
 * the real server via `app.inject`. CouchDB, the WS controller and Strom
 * (`fetch`) are mocked as in guests-return-only.test.ts.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import type { GuestInviteDoc, GuestSessionDoc, ProductionDoc, SourceDoc } from '../db/types.js';

const TEST_API_KEY = 'test-secret-key';
process.env['API_KEY'] = TEST_API_KEY;
process.env['GUEST_INVITE_SECRET'] = 'test-hmac-secret';
process.env['PUBLIC_BASE_URL'] = 'https://live.example.com';
process.env['STROM_URL'] = 'http://strom.test';

const invitesStore = new Map<string, GuestInviteDoc>();
const sessionsStore = new Map<string, GuestSessionDoc>();
const productionsStore = new Map<string, ProductionDoc>();
const sourcesStore = new Map<string, Partial<SourceDoc>>();

const notFound = () => Object.assign(new Error('not_found'), { statusCode: 404 });

function matchSelector<T>(docs: T[], selector: Record<string, unknown>): T[] {
  return docs.filter((d) =>
    Object.entries(selector).every(([k, v]) => (d as Record<string, unknown>)[k] === v),
  );
}

function store<T extends { _id: string }>(m: Map<string, T>) {
  return {
    get: vi.fn(async (id: string) => {
      const doc = m.get(id);
      if (!doc) throw notFound();
      return doc;
    }),
    insert: vi.fn(async (doc: T) => {
      m.set(doc._id, { ...doc, _rev: '1-x' });
      return { ok: true, rev: '1-x' };
    }),
    destroy: vi.fn(),
    find: vi.fn(async (q: { selector: Record<string, unknown> }) => ({
      docs: matchSelector(Array.from(m.values()), q.selector),
    })),
  };
}

vi.mock('../db/index.js', () => ({
  getDb: () => store(productionsStore),
  getGuestInvitesDb: () => store(invitesStore),
  getGuestSessionsDb: () => store(sessionsStore),
  getSourcesDb: () => store(sourcesStore as Map<string, Partial<SourceDoc> & { _id: string }>),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  applyReturnMode: vi.fn().mockResolvedValue({ ok: true, mixerInput: 'video_in_1', mode: 'program-minus' }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const AUTH = { authorization: `Bearer ${TEST_API_KEY}` };
let app: FastifyInstance;
let buildServer: () => Promise<FastifyInstance>;

/** video_in_0 is a WHIP guest slot; video_in_1 is an SRT guest slot. */
function seedProduction() {
  sourcesStore.set('src-srt', { _id: 'src-srt', streamType: 'srt', name: 'Phone on cellular' });
  productionsStore.set('prod-1', {
    _id: 'prod-1',
    _rev: '1-a',
    type: 'production',
    name: 'Race',
    status: 'active',
    stromFlowId: 'flow-1',
    sources: [
      { sourceId: 'Whip', mixerInput: 'video_in_0', returnFeed: { synced: 'program-minus' } },
      { sourceId: 'src-srt', mixerInput: 'video_in_1', returnFeed: { synced: 'program-minus' } },
    ],
    returnWhepUrls: [
      { mixerInput: 'video_in_0', url: 'http://strom.test/whep/return-0' },
      { mixerInput: 'video_in_1', url: 'http://strom.test/whep/return-1' },
    ],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '',
    updatedAt: '',
  } as unknown as ProductionDoc);
}

function setSlotSource(mixerInput: string, sourceId: string) {
  const p = productionsStore.get('prod-1')!;
  productionsStore.set('prod-1', {
    ...p,
    sources: p.sources.map((s) => (s.mixerInput === mixerInput ? { ...s, sourceId } : s)),
  });
}

async function invite(mixerInput: string): Promise<{ id: string; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/productions/prod-1/guests/invites',
    headers: AUTH,
    payload: { mixerInput },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

/** Just enough of an element for the page script. */
class FakeElement {
  textContent = '';
  innerHTML = '';
  disabled = false;
  className = '';
  value = '';
  srcObject: unknown = null;
  private classes: Set<string>;
  private listeners: Record<string, Array<() => void>> = {};
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(hidden = false) {
    this.classes = new Set(hidden ? ['hidden'] : []);
  }
  get hidden() {
    return this.classes.has('hidden');
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  appendChild() {}
  /** A disabled button ignores clicks, as in a browser. */
  click() {
    if (!this.disabled) (this.listeners['click'] ?? []).forEach((fn) => fn());
  }
}

/** Lets the page's promise chains (fetch → inject → Strom mock) run to the end. */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2));
}

async function loadPage(inv: { id: string; token: string }, options: { slotCheckFails?: boolean } = {}) {
  const html = (await app.inject({ method: 'GET', url: `/guest/${inv.id}` })).body;
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
  const hiddenAtStart = new Set(['onair-badge', 'return', 'return-hint', 'mute', 'leave', 'return-mode', 'self-warning']);
  const els: Record<string, FakeElement> = {};
  for (const id of ['banner', 'muted-indicator', 'onair-badge', 'preview', 'preview-hint', 'return',
    'return-hint', 'cam', 'mic', 'pickers', 'golive', 'mute', 'leave', 'return-mode', 'mode-program-minus',
    'mode-program', 'self-warning']) {
    els[id] = new FakeElement(hiddenAtStart.has(id));
  }
  const tracks: Array<{ kind: string; enabled: boolean; stopped: boolean; stop(): void }> = [];
  const getUserMedia = vi.fn(async () => {
    const opened = ['video', 'audio'].map((kind) => ({
      kind,
      enabled: true,
      stopped: false,
      stop() { this.stopped = true; },
    }));
    tracks.push(...opened);
    return { getTracks: () => opened, getAudioTracks: () => opened.filter((t) => t.kind === 'audio') };
  });
  const peers: Array<{ sentTracks: number; transceivers: number }> = [];
  class FakePeerConnection {
    iceGatheringState = 'complete';
    localDescription: { sdp: string } | null = null;
    counts = { sentTracks: 0, transceivers: 0 };
    constructor() { peers.push(this.counts); }
    addTrack() { this.counts.sentTracks++; }
    addTransceiver() { this.counts.transceivers++; }
    addEventListener() {}
    async createOffer() { return { type: 'offer', sdp: 'v=0 offer' }; }
    async setLocalDescription(d: { sdp: string }) { this.localDescription = d; }
    async setRemoteDescription() {}
    close() {}
  }
  const pageFetch = async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = new URL(url, 'https://live.example.com');
    if (options.slotCheckFails && u.pathname.endsWith('/slot')) throw new TypeError('Failed to fetch');
    const res = await app.inject({
      method: (opts.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers: opts.headers ?? {},
      payload: opts.body,
    });
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      status: res.statusCode,
      json: async () => JSON.parse(res.body),
      text: async () => res.body,
      headers: { get: (k: string) => (res.headers[k.toLowerCase()] as string | undefined) ?? null },
    };
  };
  const win: Record<string, unknown> = {
    location: { pathname: `/guest/${inv.id}`, hash: `#${inv.token}`, origin: 'https://live.example.com' },
    navigator: { mediaDevices: { getUserMedia, enumerateDevices: async () => [] } },
    RTCPeerConnection: FakePeerConnection,
    fetch: pageFetch,
    document: { getElementById: (id: string) => els[id], createElement: () => new FakeElement() },
    addEventListener: () => {},
    setTimeout, clearTimeout, Promise, JSON, encodeURIComponent, console, Error, TypeError,
    // The return-mode poll never fires here; these tests stop at going live.
    setInterval: () => 0,
    clearInterval: () => {},
  };
  win['window'] = win;
  vm.runInNewContext(script, win);
  await settle();
  return { els, getUserMedia, peers, tracks };
}

beforeAll(async () => {
  ({ buildServer } = await import('../server.js'));
});

beforeEach(async () => {
  invitesStore.clear();
  sessionsStore.clear();
  productionsStore.clear();
  sourcesStore.clear();
  // Fresh server per test: the guest routes rate-limit at 10/min.
  app = await buildServer();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => 'v=0 mock-answer-sdp',
      headers: { get: () => null },
    }),
  );
});

describe('guest page on a return-only slot', () => {
  it('never asks for a camera or microphone, and Join plays the return without publishing', async () => {
    seedProduction();
    const page = await loadPage(await invite('video_in_1'));
    expect(page.getUserMedia).not.toHaveBeenCalled();
    expect(page.els['preview'].hidden).toBe(true);
    expect(page.els['pickers'].hidden).toBe(true);
    expect(page.els['golive'].textContent).toBe('Join');
    expect(page.els['golive'].disabled).toBe(false);

    page.els['golive'].click();
    await settle();
    expect(page.els['banner'].className).toBe('live');
    expect(page.peers.some((pc) => pc.transceivers > 0)).toBe(true); // return opened
    expect(page.peers.every((pc) => pc.sentTracks === 0)).toBe(true); // nothing published
    expect(page.els['mute'].hidden).toBe(true);
    expect(page.els['return-mode'].hidden).toBe(false); // can pick program or program-minus
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/whip/'), expect.anything());
  });

  it('still opens the camera and publishes on a WHIP slot', async () => {
    seedProduction();
    const page = await loadPage(await invite('video_in_0'));
    expect(page.getUserMedia).toHaveBeenCalled();
    expect(page.els['golive'].disabled).toBe(false);

    page.els['golive'].click();
    await settle();
    expect(page.els['banner'].className).toBe('live');
    expect(page.peers.some((pc) => pc.sentTracks > 0)).toBe(true);
    expect(page.els['mute'].hidden).toBe(false);
  });

  it('falls back to the camera when the slot check cannot reach the server', async () => {
    seedProduction();
    const page = await loadPage(await invite('video_in_0'), { slotCheckFails: true });
    expect(page.getUserMedia).toHaveBeenCalled();
    expect(page.els['golive'].disabled).toBe(false);

    page.els['golive'].click();
    await settle();
    expect(page.els['banner'].className).toBe('live');
    expect(page.peers.some((pc) => pc.sentTracks > 0)).toBe(true);
  });

  it('opens the camera at Join when the slot was switched to WHIP after the page loaded', async () => {
    seedProduction();
    const page = await loadPage(await invite('video_in_1'));
    expect(page.getUserMedia).not.toHaveBeenCalled();
    setSlotSource('video_in_1', 'Whip');

    page.els['golive'].click();
    await settle();
    expect(page.getUserMedia).toHaveBeenCalled();
    expect(page.els['banner'].className).toBe('live');
    expect(page.peers.some((pc) => pc.sentTracks > 0)).toBe(true);
    expect(page.els['mute'].hidden).toBe(false);
  });

  it('releases the camera at Join when the slot was switched away from WHIP after the page loaded', async () => {
    seedProduction();
    const page = await loadPage(await invite('video_in_0'));
    expect(page.getUserMedia).toHaveBeenCalled();
    setSlotSource('video_in_0', 'src-srt');

    page.els['golive'].click();
    await settle();
    expect(page.els['banner'].className).toBe('live');
    expect(page.tracks.every((t) => t.stopped)).toBe(true);
    expect(page.els['preview'].hidden).toBe(true);
    expect(page.peers.every((pc) => pc.sentTracks === 0)).toBe(true);
  });

  it('lets the guest go live once a slot that was unavailable at page load is restored', async () => {
    seedProduction();
    const inv = await invite('video_in_0');
    const prod = productionsStore.get('prod-1')!;
    productionsStore.set('prod-1', {
      ...prod,
      sources: prod.sources.map((s) => (s.mixerInput === 'video_in_0' ? { ...s, returnFeed: undefined } : s)),
    });
    const page = await loadPage(inv);
    productionsStore.set('prod-1', prod);

    page.els['golive'].click();
    await settle();
    expect(page.els['banner'].className).toBe('live');
    expect(page.peers.some((pc) => pc.sentTracks > 0)).toBe(true);
  });

  it('stops at page load on an expired invite', async () => {
    seedProduction();
    const inv = await invite('video_in_0');
    const doc = invitesStore.get(inv.id)!;
    invitesStore.set(inv.id, { ...doc, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const page = await loadPage(inv);
    expect(page.getUserMedia).not.toHaveBeenCalled();
    expect(page.els['golive'].disabled).toBe(true);
    expect(page.els['banner'].textContent).toMatch(/expired/);
  });
});
