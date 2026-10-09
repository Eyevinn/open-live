/**
 * The guest page's return-feed playback, run in a VM with fake DOM, fetch and
 * RTCPeerConnection objects:
 *  - with only a picture feed, the guest hears the picture's audio;
 *  - with a fast feed, the picture plays muted on one PeerConnection and the
 *    fast feed's audio plays on a second, audio-only one;
 *  - if the fast feed fails, the picture's audio is unmuted;
 *  - in `program` the guest hears the picture's audio, since the fast feed is
 *    always mix-minus, and a mode change, the guest's or the crew's, moves the
 *    audio between the two feeds;
 *  - on leave and on page close, both return sessions are deleted before the
 *    guest session;
 *  - a return DELETE that never answers, or that fails at once, does not delay
 *    or stop the guest session's DELETE;
 *  - a page close after a Leave sends no second guest session DELETE, unless
 *    a late join made the page live again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
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

class FakeElement {
  textContent = '';
  className = '';
  innerHTML = '';
  value = '';
  disabled = false;
  muted = false;
  checked = false;
  srcObject: unknown = null;
  private classes = new Set<string>();
  private listeners: Record<string, Array<() => void>> = {};
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
}

interface FakePc {
  kinds: string[];
  closed: boolean;
  trackListener?: (e: { streams: unknown[] }) => void;
}

interface Request {
  method: string;
  url: string;
}

type Feed = { id: string; url: string; video: boolean };

const RETURN_URL = 'https://live.example.com/api/v1/guests/inv-1/session/return';
const MODES = [
  { key: 'program', label: 'Program', synced: true, delivery: { kind: 'picture-switch' } },
  { key: 'program-minus', label: 'Program minus me', synced: true, excludesMixerInput: 'in1', delivery: { kind: 'picture-switch' } },
  { key: 'low-latency-minus', label: 'Conversation (low latency)', synced: false, excludesMixerInput: 'in1', delivery: { kind: 'feed', feed: 'fast' } },
];

function runPage(script: string, feeds: Feed[], opts: { failFast?: boolean; returnMode?: string; hangReturnDelete?: boolean; hook?: (method: string, url: string) => Promise<never> | undefined; joinGate?: (n: number) => Promise<void> | undefined } = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave']) el(id).classList.add('hidden');

  const pcs: FakePc[] = [];
  const requests: Request[] = [];
  const server = { mode: opts.returnMode ?? 'program-minus' };
  let interval: (() => void) | null = null;
  const windowListeners: Record<string, Array<() => void>> = {};

  class RTCPeerConnection {
    state: FakePc = { kinds: [], closed: false };
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    constructor() { pcs.push(this.state); }
    addTrack() {}
    addTransceiver(kind: string) { this.state.kinds.push(kind); }
    addEventListener(type: string, fn: (e: { streams: unknown[] }) => void) {
      if (type === 'track') this.state.trackListener = fn;
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() {
      const stream = { id: `stream-${pcs.indexOf(this.state)}` };
      this.state.trackListener?.({ streams: [stream] });
      return Promise.resolve();
    }
    close() { this.state.closed = true; }
  }

  let joins = 0;
  const fetch = (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, url });
    opts.hook?.(method, url);
    const headers = (loc: string | null) => ({ get: (h: string) => (h === 'Location' ? loc : null) });
    if (url.endsWith('/join')) {
      const gate = opts.joinGate?.(++joins);
      const joinResponse = () => ({
        ok: true, status: 200, headers: headers(null),
        json: () => Promise.resolve({
          whipUrl: 'https://live.example.com/whip', feeds, modes: MODES,
          defaultMode: 'program-minus', returnMode: server.mode,
        }),
      });
      return gate ? gate.then(joinResponse) : Promise.resolve(joinResponse());
    }
    if (method === 'DELETE' && url.includes('/whep/') && opts.hangReturnDelete) return new Promise(() => {});
    if (url === RETURN_URL) {
      if (method === 'PUT') server.mode = JSON.parse(init.body ?? '{}').mode;
      return Promise.resolve({
        ok: true, status: 200, headers: headers(null),
        json: () => Promise.resolve({ mixerInput: 'in1', mode: server.mode, modes: MODES }),
      });
    }
    if (method === 'POST' && url.endsWith('/fast/whep') && opts.failFast) {
      return Promise.resolve({ ok: false, status: 502, headers: headers(null), text: () => Promise.resolve('') });
    }
    if (method === 'POST' && url.endsWith('/whep')) {
      const feed = url.endsWith('/fast/whep') ? 'fast' : 'picture';
      return Promise.resolve({
        ok: true, status: 201, headers: headers(`/api/v1/guests/inv-1/returns/${feed}/whep/s-${feed}`),
        text: () => Promise.resolve('answer'),
      });
    }
    return Promise.resolve({ ok: true, status: 201, headers: headers('/whip/s1'), text: () => Promise.resolve('answer') });
  };

  const track = { enabled: true, stop() {} };
  const context = {
    document: {
      getElementById: el,
      createElement: () => new FakeElement(),
    },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
        enumerateDevices: () => Promise.resolve([]),
      },
    },
    window: {
      RTCPeerConnection,
      addEventListener: (type: string, fn: () => void) => { (windowListeners[type] ??= []).push(fn); },
    },
    RTCPeerConnection,
    fetch,
    URL,
    Promise,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: (fn: () => void) => { interval = fn; return 1; },
    clearInterval: () => { interval = null; },
  };
  vm.runInNewContext(script, context);
  return {
    els,
    pcs,
    requests,
    server,
    /** Runs one return-mode poll tick, if polling. */
    tick: () => interval?.(),
    fireWindow: (type: string) => (windowListeners[type] ?? []).forEach((fn) => fn()),
    pick: (mode: string) => {
      const input = el(`mode-${mode}`);
      input.checked = true;
      input.fire('change');
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

const PICTURE: Feed = { id: 'picture', url: 'https://live.example.com/api/v1/guests/inv-1/returns/picture/whep', video: true };
const FAST: Feed = { id: 'fast', url: 'https://live.example.com/api/v1/guests/inv-1/returns/fast/whep', video: false };

const sessionDeletes = (requests: Request[]) =>
  requests.filter((r) => r.method === 'DELETE' && r.url.endsWith('/session')).length;

afterEach(() => {
  vi.useRealTimers();
});

describe('guest page return feeds', () => {
  it('plays the picture feed with its own audio when there is no fast feed', async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE]);
    await flush();
    els['golive'].fire('click');
    await flush();
    // pcs[0] is the WHIP publish.
    expect(pcs).toHaveLength(2);
    expect(pcs[1].kinds).toEqual(['video', 'audio']);
    expect(els['return'].muted).toBe(false);
    expect(els['return'].srcObject).toEqual({ id: 'stream-1' });
    expect(els['return-audio'].srcObject).toBeNull();
  });

  it('plays the fast feed on its own audio-only PeerConnection and mutes the picture', async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    els['golive'].fire('click');
    await flush();
    expect(pcs).toHaveLength(3);
    expect(pcs[1].kinds).toEqual(['video', 'audio']);
    expect(pcs[2].kinds).toEqual(['audio']);
    expect(els['return'].muted).toBe(true);
    expect(els['return-audio'].muted).toBe(false);
    expect(els['return'].srcObject).toEqual({ id: 'stream-1' });
    expect(els['return-audio'].srcObject).toEqual({ id: 'stream-2' });
  });

  it('picks the feeds by id, whatever order the join lists them in', async () => {
    const { els, pcs, requests } = runPage(await pageScript(), [FAST, PICTURE]);
    await flush();
    els['golive'].fire('click');
    await flush();
    const posts = requests.filter((r) => r.method === 'POST' && r.url.endsWith('/whep')).map((r) => r.url);
    expect(posts).toEqual([PICTURE.url, FAST.url]);
    expect(pcs[1].kinds).toEqual(['video', 'audio']);
    expect(pcs[2].kinds).toEqual(['audio']);
    expect(els['return'].muted).toBe(true);
    expect(els['return-audio'].muted).toBe(false);
  });

  it("plays the picture's audio and mutes the fast feed when the guest joins in program", async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE, FAST], { returnMode: 'program' });
    await flush();
    els['golive'].fire('click');
    await flush();
    // The fast feed stays connected, muted, so a switch back to program-minus is instant.
    expect(pcs).toHaveLength(3);
    expect(pcs[2].closed).toBe(false);
    expect(els['return-audio'].srcObject).toEqual({ id: 'stream-2' });
    expect(els['return'].muted).toBe(false);
    expect(els['return-audio'].muted).toBe(true);
  });

  it('moves the audio between the feeds when the guest or the crew changes the mode', async () => {
    const page = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    page.els['golive']!.fire('click');
    await flush();
    expect(page.els['return']!.muted).toBe(true);

    page.pick('program');
    await flush();
    expect(page.server.mode).toBe('program');
    expect(page.els['return']!.muted).toBe(false);
    expect(page.els['return-audio']!.muted).toBe(true);

    // The crew switches back; the poll picks it up.
    page.server.mode = 'program-minus';
    page.tick();
    await flush();
    expect(page.els['return']!.muted).toBe(true);
    expect(page.els['return-audio']!.muted).toBe(false);
  });

  it("unmutes the picture's audio when the fast feed fails", async () => {
    const { els, pcs } = runPage(await pageScript(), [PICTURE, FAST], { failFast: true });
    await flush();
    els['golive'].fire('click');
    await flush();
    expect(els['return'].muted).toBe(false);
    expect(pcs[2].closed).toBe(true);
    expect(els['return-audio'].srcObject).toBeNull();
  });

  it('deletes both return sessions before the guest session on leave', async () => {
    const { els, pcs, requests } = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    els['golive'].fire('click');
    await flush();
    els['leave'].fire('click');
    await flush();
    const deletes = requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
    expect(deletes).toEqual([
      'https://live.example.com/api/v1/guests/inv-1/returns/picture/whep/s-picture',
      'https://live.example.com/api/v1/guests/inv-1/returns/fast/whep/s-fast',
      'https://live.example.com/api/v1/guests/inv-1/session',
    ]);
    expect(pcs[1].closed).toBe(true);
    expect(pcs[2].closed).toBe(true);
  });
  it('deletes both return sessions before the guest session when the page closes', async () => {
    const { els, pcs, requests, fireWindow } = runPage(await pageScript(), [PICTURE, FAST]);
    await flush();
    els['golive'].fire('click');
    await flush();
    fireWindow('pagehide');
    const deletes = requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
    expect(deletes).toEqual([
      'https://live.example.com/api/v1/guests/inv-1/returns/picture/whep/s-picture',
      'https://live.example.com/api/v1/guests/inv-1/returns/fast/whep/s-fast',
      'https://live.example.com/api/v1/guests/inv-1/session',
    ]);
    expect(pcs[1].closed).toBe(true);
    expect(pcs[2].closed).toBe(true);
  });

  it('ends the guest session at once on Leave while a return DELETE is unanswered', async () => {
    vi.useFakeTimers();
    const { els, requests } = runPage(await pageScript(), [PICTURE], { hangReturnDelete: true });
    await vi.advanceTimersByTimeAsync(10);
    els['golive'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    els['leave'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionDeletes(requests)).toBe(1);
    expect(els['banner'].textContent).toMatch(/You have left/);
  });

  it('sends no second guest session DELETE when the page closes after a Leave', async () => {
    vi.useFakeTimers();
    const { els, requests, fireWindow } = runPage(await pageScript(), [PICTURE]);
    await vi.advanceTimersByTimeAsync(10);
    els['golive'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    els['leave'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    fireWindow('pagehide');
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionDeletes(requests)).toBe(1);
  });

  it('ends the session a late join created when the page closes after a Leave pressed during a Rejoin', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { els, requests, fireWindow } = runPage(await pageScript(), [PICTURE], { joinGate: (n) => (n === 2 ? gate : undefined) });
    await vi.advanceTimersByTimeAsync(10);
    els['golive'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    els['rejoin'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    els['leave'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    expect(sessionDeletes(requests)).toBe(1);
    // The join is answered after the Leave, and the page claims to be live again.
    release();
    await vi.advanceTimersByTimeAsync(50);
    fireWindow('pagehide');
    expect(sessionDeletes(requests)).toBe(2);
  });

  it('still ends the session on Leave and on page close when a return DELETE fails at once', async () => {
    const hook = (method: string, url: string) => {
      if (method === 'DELETE' && url.includes('/whep/')) throw new TypeError('fetch failed');
      return undefined;
    };
    for (const how of ['leave', 'pagehide']) {
      vi.useFakeTimers();
      const { els, requests, fireWindow } = runPage(await pageScript(), [PICTURE], { hook });
      await vi.advanceTimersByTimeAsync(10);
      els['golive'].fire('click');
      await vi.advanceTimersByTimeAsync(10);
      if (how === 'leave') els['leave'].fire('click');
      else fireWindow('pagehide');
      await vi.advanceTimersByTimeAsync(10);
      expect(sessionDeletes(requests)).toBe(1);
      vi.useRealTimers();
    }
  });

  it('shows the guest as left when the guest session DELETE fails at once', async () => {
    vi.useFakeTimers();
    const hook = (method: string, url: string) => {
      if (method === 'DELETE' && url.endsWith('/session')) throw new TypeError('fetch failed');
      return undefined;
    };
    const { els } = runPage(await pageScript(), [PICTURE], { hook });
    await vi.advanceTimersByTimeAsync(10);
    els['golive'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    els['leave'].fire('click');
    await vi.advanceTimersByTimeAsync(10);
    expect(els['banner'].textContent).toMatch(/You have left/);
  });
});
