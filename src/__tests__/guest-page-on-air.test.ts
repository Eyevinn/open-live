/**
 * The guest page's ON AIR badge (issue #592), run in a VM with fake DOM, fetch,
 * RTCPeerConnection and interval objects:
 *  - once live on a WHIP slot the page polls `GET …/session/status` right away
 *    and every MODE_POLL_MS (5000 ms), on its own timer;
 *  - `onAir: true` unhides `#onair-badge` and adds the `onair` class to the live
 *    `#banner`; `onAir: false` takes both away again;
 *  - leaving stops the poll and hides the badge, and so do three 401s in a row
 *    (the guest was kicked or the invite revoked); a single 401 does not;
 *  - an answer that arrives after the poll stopped is dropped;
 *  - a return-only slot (join returns no `whipUrl`) never polls and never
 *    shows the badge.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import Fastify from 'fastify';
import guestPageRoutes from '../routes/guest-page.js';

async function pageScript(): Promise<string> {
  const app = Fastify();
  await app.register(guestPageRoutes);
  const res = await app.inject({ method: 'GET', url: '/guest/inv-1' });
  await app.close();
  const m = /<script>([\s\S]*)<\/script>/.exec(res.body);
  if (!m) throw new Error('no inline script');
  return m[1]!;
}

/** `className` and `classList` share one class set, as in a browser. */
class FakeElement {
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  muted = false;
  checked = false;
  srcObject: unknown = null;
  private classes = new Set<string>();
  private listeners: Record<string, Array<() => void>> = {};
  get className() {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter(Boolean));
  }
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  appendChild() {}
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    (this.listeners[type] ?? []).forEach((fn) => fn());
  }
  get hidden() {
    return this.classes.has('hidden');
  }
}

const STATUS_URL = 'https://live.example.com/api/v1/guests/inv-1/session/status';

interface PageOpts {
  /** Join returns no whipUrl: the slot is return-only. */
  returnOnly?: boolean;
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  for (const id of ['onair-badge', 'return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave']) {
    el(id).classList.add('hidden');
  }

  const server = { onAir: false, status: 200 };
  const statusGets: string[] = [];
  // Status GETs wait here until the test releases them.
  const held: Array<() => void> = [];
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 0;

  class RTCPeerConnection {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    addTrack() {}
    addTransceiver() {}
    addEventListener() {}
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() {}
  }

  const respond = (status: number, json: unknown, location: string | null = null) =>
    Promise.resolve({
      ok: status < 400,
      status,
      headers: { get: (h: string) => (h === 'Location' ? location : null) },
      json: () => Promise.resolve(json),
      text: () => Promise.resolve('answer'),
    });

  const fetch = (url: string, init: { method?: string } = {}) => {
    const method = init.method ?? 'GET';
    if (url.endsWith('/slot')) return respond(200, { mixerInput: 'video_in_0', returnOnly: !!opts.returnOnly });
    if (url.endsWith('/join')) {
      return respond(200, {
        ...(opts.returnOnly ? {} : { whipUrl: 'https://live.example.com/whip' }),
        feeds: [],
        modes: [],
        defaultMode: 'program-minus',
        returnMode: 'program-minus',
      });
    }
    if (url === STATUS_URL && method === 'GET') {
      statusGets.push(url);
      const status = server.status;
      const onAir = server.onAir;
      return new Promise((resolve) => {
        held.push(() => resolve(respond(status, status === 200 ? { onAir } : { error: 'Invalid or expired invite' })));
      });
    }
    return respond(201, {}, '/whip/s1');
  };

  const track = { kind: 'video', enabled: true, stop() {} };
  const context = {
    document: { getElementById: el, createElement: () => new FakeElement() },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [] }),
        enumerateDevices: () => Promise.resolve([]),
      },
    },
    window: { RTCPeerConnection, addEventListener() {} },
    RTCPeerConnection,
    fetch,
    URL,
    Promise,
    AbortController,
    setTimeout: (fn: () => void, ms: number) => (ms >= 5000 ? 0 : setTimeout(fn, ms)),
    clearTimeout: () => {},
    setInterval: (fn: () => void, ms: number) => { intervals.set(++nextId, { fn, ms }); return nextId; },
    clearInterval: (id: number) => { intervals.delete(id); },
  };
  vm.runInNewContext(script, context);

  const onAirPoll = () => [...intervals.values()].find((i) => i.fn.name === 'pollOnAir') ?? null;
  return {
    els,
    server,
    statusGets,
    onAirPoll,
    /** Runs one on-air poll tick, if polling. */
    tick: () => onAirPoll()?.fn(),
    release: () => held.splice(0).forEach((r) => r()),
    badgeShown: () => !els['onair-badge']!.hidden,
    bannerOnAir: () => els['banner']!.classList.contains('onair'),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

async function goLive(opts: PageOpts = {}) {
  const page = runPage(await pageScript(), opts);
  await flush();
  page.els['golive']!.fire('click');
  await flush();
  return page;
}

/** Tick, answer, and let the page apply it. */
async function poll(page: Awaited<ReturnType<typeof goLive>>) {
  page.tick();
  page.release();
  await flush();
}

describe('guest page ON AIR badge (issue #592)', () => {
  it('polls the status route once live, at MODE_POLL_MS', async () => {
    const page = await goLive();
    expect(page.statusGets.length).toBe(1); // right away, not only after the first interval
    expect(page.onAirPoll()?.ms).toBe(5000);
    page.release();
    await flush();
    expect(page.badgeShown()).toBe(false);
    expect(page.bannerOnAir()).toBe(false);
  });

  it('shows the badge and onair banner within one poll of a cut to the guest, and hides them on cutting away', async () => {
    const page = await goLive();
    page.release();
    await flush();

    page.server.onAir = true;
    await poll(page);
    expect(page.badgeShown()).toBe(true);
    expect(page.bannerOnAir()).toBe(true);
    // Still the live banner underneath.
    expect(page.els['banner']!.classList.contains('live')).toBe(true);

    page.server.onAir = false;
    await poll(page);
    expect(page.badgeShown()).toBe(false);
    expect(page.bannerOnAir()).toBe(false);
    expect(page.els['banner']!.classList.contains('live')).toBe(true);
  });

  it('leaving stops the poll and hides the badge; a late answer is dropped', async () => {
    const page = await goLive();
    page.release();
    page.server.onAir = true;
    await poll(page);
    expect(page.badgeShown()).toBe(true);

    page.tick(); // in flight when the guest leaves
    page.els['leave']!.fire('click');
    await flush();
    expect(page.onAirPoll()).toBeNull();
    expect(page.badgeShown()).toBe(false);
    page.release();
    await flush();
    expect(page.badgeShown()).toBe(false);
    expect(page.bannerOnAir()).toBe(false);
  });

  it('stops polling and hides the badge after three 401s in a row (guest kicked)', async () => {
    const page = await goLive();
    page.release();
    page.server.onAir = true;
    await poll(page);
    expect(page.badgeShown()).toBe(true);

    page.server.status = 401;
    await poll(page);
    await poll(page);
    expect(page.onAirPoll()).not.toBeNull();
    expect(page.badgeShown()).toBe(true);
    await poll(page);
    expect(page.onAirPoll()).toBeNull();
    expect(page.badgeShown()).toBe(false);
    expect(page.bannerOnAir()).toBe(false);
  });

  it('keeps polling through a single 401 (a momentary server error)', async () => {
    const page = await goLive();
    page.release();
    await flush();
    page.server.status = 401;
    await poll(page);
    page.server.status = 200;
    page.server.onAir = true;
    await poll(page);
    expect(page.onAirPoll()).not.toBeNull();
    expect(page.badgeShown()).toBe(true);
  });

  it('a return-only slot never polls and never shows the badge', async () => {
    const page = await goLive({ returnOnly: true });
    page.server.onAir = true;
    page.tick();
    page.release();
    await flush();
    expect(page.els['banner']!.classList.contains('live')).toBe(true);
    expect(page.statusGets.length).toBe(0);
    expect(page.onAirPoll()).toBeNull();
    expect(page.badgeShown()).toBe(false);
    expect(page.bannerOnAir()).toBe(false);
  });
});
