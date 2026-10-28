/**
 * The guest page's talkback client (guest-talkback spec §5.1, issue #601), run
 * in a VM with fake DOM, media devices, fetch and RTCPeerConnection:
 *  - no talkback markup or requests when join has no `talkback`;
 *  - after Go live, WHEP (recvonly audio) first, then WHIP (sendonly) with a
 *    disabled clone of the program mic;
 *  - "Talk to producer" is a latch, default off, independent of the program mute;
 *  - a return-only slot only listens: no WHIP, no talk control, no device prompt;
 *  - the page asks for echo cancellation explicitly;
 *  - a device switch puts a clone of the new mic on the talkback sender, keeping
 *    the latch;
 *  - a failed POST or connection hides the control and retries once (after
 *    Retry-After on a 503); a 401 stops;
 *  - Leave and pagehide DELETE both talkback resources (keepalive) before the
 *    session, and close both connections.
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

class FakeElement {
  id = '';
  textContent = '';
  className = '';
  innerHTML = '';
  value = '';
  disabled = false;
  checked = false;
  muted = false;
  autoplay = false;
  srcObject: unknown = null;
  parentNode: FakeElement | null = null;
  children: FakeElement[] = [];
  attrs: Record<string, string> = {};
  private classes = new Set<string>();
  private listeners: Record<string, Array<() => void>> = {};
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  constructor(public tag = 'div') {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
  }
  insertBefore(child: FakeElement, ref: FakeElement) {
    child.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
  }
  removeChild(child: FakeElement) {
    this.children = this.children.filter((c) => c !== child);
    child.parentNode = null;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    (this.listeners[type] ?? []).forEach((fn) => fn());
  }
  get hidden() {
    return this.classes.has('hidden');
  }
  find(id: string): FakeElement | undefined {
    for (const c of this.children) {
      if (c.id === id) return c;
      const f = c.find(id);
      if (f) return f;
    }
    return undefined;
  }
}

let trackSeq = 0;
class FakeTrack {
  id = `t${++trackSeq}`;
  enabled = true;
  muted = false;
  stopped = false;
  cloneOf: FakeTrack | null = null;
  constructor(public kind: 'audio' | 'video', public deviceId: string) {}
  getSettings() {
    return { deviceId: this.deviceId };
  }
  clone() {
    const c = new FakeTrack(this.kind, this.deviceId);
    c.enabled = this.enabled;
    c.cloneOf = this;
    return c;
  }
  stop() {
    this.stopped = true;
  }
  addEventListener() {}
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks.slice();
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

interface Sender {
  track: FakeTrack | null;
  replaceTrack(t: FakeTrack): Promise<void>;
}
interface Transceiver {
  what: string | FakeTrack;
  direction: string;
  sender: Sender;
}

const BASE = 'https://live.example.com';
const TB_WHIP = `${BASE}/api/v1/guests/inv-1/talkback/whip`;
const TB_WHEP = `${BASE}/api/v1/guests/inv-1/talkback/whep`;
const TB_WHIP_RES = '/api/v1/guests/inv-1/talkback/whip/s-whip';
const TB_WHEP_RES = '/api/v1/guests/inv-1/talkback/whep/s-whep';

interface PageOpts {
  /** The join's `talkback` field; omitted when undefined. */
  talkback?: { whipUrl?: string; whepUrl: string };
  /** The slot is return-only (slot check and join say so). */
  returnOnly?: boolean;
  /** Status for each talkback POST, by kind, in order; 201 when exhausted. */
  talkbackStatus?: { whip?: number[]; whep?: number[] };
  retryAfter?: string;
}

interface Req {
  method: string;
  url: string;
  keepalive?: boolean;
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => {
    if (!els[id]) {
      els[id] = new FakeElement();
      els[id]!.id = id;
    }
    return els[id]!;
  };
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave', 'device-alert', 'rejoin']) {
    el(id).classList.add('hidden');
  }
  // The pickers sit in <main>, where the page inserts the talkback box.
  const main = new FakeElement('main');
  main.appendChild(el('pickers'));

  const requests: Req[] = [];
  const gumCalls: unknown[] = [];
  const created: FakeElement[] = [];
  const longTimers: Array<{ ms: number; fn: () => void }> = [];
  const windowListeners: Record<string, Array<() => void>> = {};
  const peers: FakePc[] = [];

  class FakePc {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    connectionState = 'new';
    closed = false;
    transceivers: Transceiver[] = [];
    senders: Sender[] = [];
    replaced: FakeTrack[] = [];
    private listeners: Record<string, Array<(e?: unknown) => void>> = {};
    constructor() {
      peers.push(this);
    }
    private sender(t: FakeTrack | null): Sender {
      const s: Sender = {
        track: t,
        replaceTrack: (next: FakeTrack) => {
          s.track = next;
          this.replaced.push(next);
          return Promise.resolve();
        },
      };
      return s;
    }
    addTrack(t: FakeTrack) {
      const s = this.sender(t);
      this.senders.push(s);
      return s;
    }
    addTransceiver(what: string | FakeTrack, init: { direction: string }) {
      const tx = { what, direction: init.direction, sender: this.sender(typeof what === 'string' ? null : what) };
      this.transceivers.push(tx);
      return tx;
    }
    addEventListener(type: string, fn: (e?: unknown) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    setState(state: string) {
      this.connectionState = state;
      (this.listeners['connectionstatechange'] ?? []).forEach((fn) => fn());
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() { this.closed = true; }
  }

  const respond = (status: number, json: unknown, location: string | null = null, retryAfter: string | null = null) =>
    Promise.resolve({
      ok: status < 400,
      status,
      headers: {
        get: (h: string) => (h === 'Location' ? location : h === 'Retry-After' ? retryAfter : null),
      },
      json: () => Promise.resolve(json),
      text: () => Promise.resolve('answer'),
    });

  const tbStatus = { whip: [...(opts.talkbackStatus?.whip ?? [])], whep: [...(opts.talkbackStatus?.whep ?? [])] };
  const fetch = (url: string, init: { method?: string; keepalive?: boolean } = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, url, keepalive: init.keepalive });
    if (url.endsWith('/slot')) return respond(200, { returnOnly: !!opts.returnOnly });
    if (url.endsWith('/join')) {
      return respond(200, {
        ...(opts.returnOnly ? {} : { whipUrl: `${BASE}/whip` }),
        feeds: [],
        ...(opts.talkback ? { talkback: opts.talkback } : {}),
      });
    }
    if (method === 'POST' && (url === TB_WHIP || url === TB_WHEP)) {
      const kind = url === TB_WHIP ? 'whip' : 'whep';
      const status = tbStatus[kind].shift() ?? 201;
      if (status !== 201) return respond(status, { error: 'nope' }, null, opts.retryAfter ?? null);
      return respond(201, {}, kind === 'whip' ? TB_WHIP_RES : TB_WHEP_RES);
    }
    return respond(201, {}, '/whip/s1');
  };

  const getUserMedia = (c: { audio?: unknown; video?: unknown }) => {
    gumCalls.push(c);
    const tracks: FakeTrack[] = [];
    if (c.video) tracks.push(new FakeTrack('video', 'cam-a'));
    if (c.audio) {
      const a = c.audio as { deviceId?: { exact: string } };
      tracks.push(new FakeTrack('audio', a.deviceId?.exact ?? 'mic-a'));
    }
    return Promise.resolve(new FakeStream(tracks));
  };

  const context = {
    document: {
      getElementById: el,
      createElement: (tag: string) => {
        const e = new FakeElement(tag);
        created.push(e);
        return e;
      },
    },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: BASE },
    navigator: {
      mediaDevices: {
        getUserMedia,
        enumerateDevices: () => Promise.resolve([
          { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
          { kind: 'audioinput', deviceId: 'mic-b', label: 'Mic B' },
        ]),
      },
    },
    window: {
      RTCPeerConnection: FakePc,
      addEventListener: (type: string, fn: () => void) => (windowListeners[type] ??= []).push(fn),
    },
    RTCPeerConnection: FakePc,
    MediaStream: FakeStream,
    fetch,
    URL,
    Promise,
    AbortController,
    // 5 s and longer (the talkback retry) wait for the test to fire them.
    setTimeout: (fn: () => void, ms: number) => {
      if (ms >= 5000) {
        longTimers.push({ ms, fn });
        return 1000 + longTimers.length;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout: (id: unknown) => {
      if (typeof id === 'number' && id > 1000) {
        const t = longTimers[id - 1001];
        if (t) t.fn = () => {};
        return;
      }
      clearTimeout(id as ReturnType<typeof setTimeout>);
    },
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(script, context);

  const talkbackPosts = () => requests.filter((r) => r.method === 'POST' && (r.url === TB_WHIP || r.url === TB_WHEP));
  /** Talkback peer connections: those with a transceiver (publish uses addTrack, returns are not used here). */
  const talkbackPcs = () => peers.filter((p) => p.transceivers.length > 0);
  const whepPc = () => talkbackPcs().filter((p) => p.transceivers[0]!.direction === 'recvonly').at(-1);
  const whipPc = () => talkbackPcs().filter((p) => p.transceivers[0]!.direction === 'sendonly').at(-1);
  return {
    els,
    main,
    requests,
    gumCalls,
    created,
    longTimers,
    peers,
    talkbackPosts,
    whepPc,
    whipPc,
    box: () => main.find('talkback'),
    ui: (id: string) => main.find(id),
    programAudio: () => (el('preview').srcObject as FakeStream).getAudioTracks()[0]!,
    fireWindow: (type: string) => (windowListeners[type] ?? []).forEach((fn) => fn()),
    fireTimers: () => longTimers.splice(0).forEach((t) => t.fn()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 15));

async function goLive(opts: PageOpts = {}) {
  const page = runPage(await pageScript(), opts);
  await flush();
  page.els['golive']!.fire('click');
  await flush();
  return page;
}

const WHIP_SLOT = { talkback: { whipUrl: TB_WHIP, whepUrl: TB_WHEP } };
const RETURN_ONLY = { returnOnly: true, talkback: { whepUrl: TB_WHEP } };

describe('guest page talkback', () => {
  it('renders no talkback markup and makes no talkback request when join has no talkback', async () => {
    const page = await goLive();
    expect(page.els['banner']!.textContent).toMatch(/You are live/);
    expect(page.box()).toBeUndefined();
    expect(page.created.some((e) => e.id === 'talkback' || e.id === 'talk')).toBe(false);
    expect(page.talkbackPosts()).toHaveLength(0);
    expect(page.peers).toHaveLength(1);
  });

  it('does not start before Go live', async () => {
    const page = runPage(await pageScript(), WHIP_SLOT);
    await flush();
    expect(page.box()).toBeUndefined();
    expect(page.talkbackPosts()).toHaveLength(0);
  });

  it('connects WHEP first, then WHIP with a disabled clone of the mic, after Go live', async () => {
    const page = await goLive(WHIP_SLOT);
    expect(page.talkbackPosts().map((r) => r.url)).toEqual([TB_WHEP, TB_WHIP]);

    const whep = page.whepPc()!;
    expect(whep.transceivers).toHaveLength(1);
    expect(whep.transceivers[0]).toMatchObject({ what: 'audio', direction: 'recvonly' });

    const whip = page.whipPc()!;
    expect(whip.transceivers).toHaveLength(1);
    const clone = whip.transceivers[0]!.what as FakeTrack;
    expect(clone.cloneOf).toBe(page.programAudio());
    expect(clone.enabled).toBe(false);
    expect(page.programAudio().enabled).toBe(true);

    expect(page.box()).toBeDefined();
    expect(page.ui('talkback-audio')!.tag).toBe('audio');
    expect(page.ui('talkback-audio')!.attrs['playsinline']).toBe('');
    expect(page.ui('talk')!.hidden).toBe(false);
    expect(page.ui('talk')!.attrs['aria-pressed']).toBe('false');
    expect(page.ui('talk-status')!.hidden).toBe(true);
    expect(page.ui('talkback-headphones')!.hidden).toBe(false);
    expect(page.ui('talkback-headphones')!.textContent).toBe('Use headphones for the best sound');
    expect(page.ui('talkback-unavailable')!.hidden).toBe(true);
  });

  it('asks for echo cancellation explicitly', async () => {
    const page = await goLive(WHIP_SLOT);
    expect(page.gumCalls[0]).toMatchObject({ audio: { echoCancellation: true } });
    const audio = (page.gumCalls[0] as { audio: Record<string, unknown> }).audio;
    expect(audio).not.toHaveProperty('noiseSuppression');
    expect(audio).not.toHaveProperty('autoGainControl');
  });

  it('latches "Talk to producer", independent of the program mute', async () => {
    const page = await goLive(WHIP_SLOT);
    const clone = page.whipPc()!.transceivers[0]!.what as FakeTrack;
    const program = page.programAudio();

    page.ui('talk')!.fire('click');
    expect(clone.enabled).toBe(true);
    expect(page.ui('talk')!.attrs['aria-pressed']).toBe('true');
    expect(page.ui('talk-status')!.hidden).toBe(false);
    expect(page.ui('talk-status')!.textContent).toBe('Producer can hear you');
    expect(program.enabled).toBe(true);

    // Muting the program leaves talkback on; unmuting does not turn it on.
    page.els['mute']!.fire('click');
    expect(program.enabled).toBe(false);
    expect(clone.enabled).toBe(true);

    page.ui('talk')!.fire('click');
    expect(clone.enabled).toBe(false);
    expect(page.ui('talk-status')!.hidden).toBe(true);
    page.els['mute']!.fire('click');
    expect(program.enabled).toBe(true);
    expect(clone.enabled).toBe(false);
  });

  it('only listens on a return-only slot: no WHIP, no talk control, no device prompt', async () => {
    const page = await goLive(RETURN_ONLY);
    expect(page.gumCalls).toHaveLength(0);
    expect(page.talkbackPosts().map((r) => r.url)).toEqual([TB_WHEP]);
    expect(page.peers).toHaveLength(1);
    expect(page.whipPc()).toBeUndefined();
    expect(page.ui('talk')!.hidden).toBe(true);
    expect(page.ui('talkback-headphones')!.hidden).toBe(false);
  });

  it('puts a clone of a newly picked mic on the talkback sender, keeping the latch', async () => {
    const page = await goLive(WHIP_SLOT);
    const whip = page.whipPc()!;
    const first = whip.transceivers[0]!.what as FakeTrack;
    page.ui('talk')!.fire('click');

    page.els['mic']!.value = 'mic-b';
    page.els['mic']!.fire('change');
    await flush();

    const program = page.programAudio();
    expect(program.deviceId).toBe('mic-b');
    const next = whip.transceivers[0]!.sender.track!;
    expect(next).not.toBe(first);
    expect(next.cloneOf).toBe(program);
    expect(next.enabled).toBe(true);
    expect(first.stopped).toBe(true);
    // No renegotiation for the swap.
    expect(page.talkbackPosts()).toHaveLength(2);

    page.ui('talk')!.fire('click');
    expect(next.enabled).toBe(false);
  });

  it('hides the control on a failed talkback POST and retries once after 5 s, keeping the listen side', async () => {
    const page = await goLive({ ...WHIP_SLOT, talkbackStatus: { whip: [500, 500] } });
    expect(page.ui('talk')!.hidden).toBe(true);
    expect(page.ui('talkback-unavailable')!.hidden).toBe(false);
    expect(page.ui('talkback-unavailable')!.textContent).toBe('Talkback to the producer is unavailable');
    expect(page.whepPc()!.closed).toBe(false);
    expect(page.longTimers.map((t) => t.ms)).toEqual([5000]);
    // Program publish untouched.
    expect(page.peers[0]!.closed).toBe(false);
    expect(page.els['banner']!.textContent).toMatch(/You are live/);

    page.fireTimers();
    await flush();
    expect(page.talkbackPosts().map((r) => r.url)).toEqual([TB_WHEP, TB_WHIP, TB_WHIP]);
    // Failed again: no further retry.
    expect(page.longTimers).toHaveLength(0);
    expect(page.ui('talkback-unavailable')!.hidden).toBe(false);
  });

  it('shows the control once the retry succeeds', async () => {
    const page = await goLive({ ...WHIP_SLOT, talkbackStatus: { whip: [500] } });
    page.fireTimers();
    await flush();
    expect(page.ui('talk')!.hidden).toBe(false);
    expect(page.ui('talkback-unavailable')!.hidden).toBe(true);
  });

  it('waits Retry-After on a 503, and stops on a 401', async () => {
    const throttled = await goLive({ ...WHIP_SLOT, talkbackStatus: { whep: [503] }, retryAfter: '7' });
    expect(throttled.talkbackPosts().map((r) => r.url)).toEqual([TB_WHEP]);
    expect(throttled.longTimers.map((t) => t.ms)).toEqual([7000]);
    throttled.fireTimers();
    await flush();
    expect(throttled.talkbackPosts().map((r) => r.url)).toEqual([TB_WHEP, TB_WHEP, TB_WHIP]);
    expect(throttled.ui('talk')!.hidden).toBe(false);

    const kicked = await goLive({ ...WHIP_SLOT, talkbackStatus: { whep: [401] } });
    expect(kicked.longTimers).toHaveLength(0);
    expect(kicked.ui('talkback-unavailable')!.hidden).toBe(false);
    expect(kicked.ui('talk')!.hidden).toBe(true);
  });

  it('closes both on a failed listen connection and retries once', async () => {
    const page = await goLive(WHIP_SLOT);
    const whep = page.whepPc()!;
    const whip = page.whipPc()!;
    whep.setState('failed');
    expect(whep.closed).toBe(true);
    expect(whip.closed).toBe(true);
    expect(page.ui('talk')!.hidden).toBe(true);
    expect(page.ui('talkback-unavailable')!.hidden).toBe(false);
    expect(page.peers[0]!.closed).toBe(false);

    page.fireTimers();
    await flush();
    expect(page.whepPc()).not.toBe(whep);
    expect(page.whipPc()).not.toBe(whip);
    expect(page.ui('talk')!.hidden).toBe(false);
  });

  it('Leave DELETEs both talkback resources with keepalive before the session, and closes both', async () => {
    const page = await goLive(WHIP_SLOT);
    const whep = page.whepPc()!;
    const whip = page.whipPc()!;
    page.els['leave']!.fire('click');
    await flush();

    const deletes = page.requests.filter((r) => r.method === 'DELETE');
    const urls = deletes.map((r) => new URL(r.url).pathname);
    expect(urls).toContain(TB_WHIP_RES);
    expect(urls).toContain(TB_WHEP_RES);
    expect(urls.at(-1)).toBe('/api/v1/guests/inv-1/session');
    expect(deletes.every((r) => r.keepalive)).toBe(true);
    expect(whep.closed).toBe(true);
    expect(whip.closed).toBe(true);
    expect((whip.transceivers[0]!.what as FakeTrack).stopped).toBe(true);
    expect(page.box()).toBeUndefined();
  });

  it('pagehide DELETEs both talkback resources and closes both', async () => {
    const page = await goLive(WHIP_SLOT);
    const whep = page.whepPc()!;
    const whip = page.whipPc()!;
    page.fireWindow('pagehide');

    const urls = page.requests.filter((r) => r.method === 'DELETE' && r.keepalive).map((r) => new URL(r.url).pathname);
    expect(urls.indexOf(TB_WHIP_RES)).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf(TB_WHEP_RES)).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf(TB_WHEP_RES)).toBeLessThan(urls.indexOf('/api/v1/guests/inv-1/session'));
    expect(urls.indexOf(TB_WHIP_RES)).toBeLessThan(urls.indexOf('/api/v1/guests/inv-1/session'));
    expect(whep.closed).toBe(true);
    expect(whip.closed).toBe(true);
  });
});
