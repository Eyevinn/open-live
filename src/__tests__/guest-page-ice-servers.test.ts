/**
 * The guest page's ICE servers, run in a VM with a fake DOM, media devices and
 * RTCPeerConnection (issue #563):
 *  - the page uses the join response's iceServers (Strom's list, TURN
 *    included; `urls` a string or an array) for its publish and its return,
 *    a return-only slot's return included, and keeps its STUN server without
 *    them;
 *  - it leaves out a TURN entry without a username and credential, which a
 *    browser would reject along with the whole list, and falls back to its
 *    STUN server if the browser rejects the list anyway;
 *  - it waits longer for ICE gathering when it has a TURN server.
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
  textContent = '';
  className = '';
  value = '';
  disabled = false;
  checked = false;
  selected = false;
  set innerHTML(_html: string) {
    this.options = [];
  }
  srcObject: unknown = null;
  options: FakeElement[] = [];
  private classes = new Set<string>();
  private listeners: Record<string, Array<() => void>> = {};
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    contains: (c: string) => this.classes.has(c),
  };
  appendChild(child: FakeElement) {
    this.options.push(child);
    if (child.selected || this.options.length === 1) this.value = child.value;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: string) {
    (this.listeners[type] ?? []).forEach((fn) => fn());
  }
}

class FakeTrack {
  enabled = true;
  muted = false;
  constructor(public kind: 'audio' | 'video') {}
  getSettings() {
    return { deviceId: `${this.kind}-a` };
  }
  stop() {}
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

const DEVICES = [
  { kind: 'videoinput', deviceId: 'video-a', label: 'Cam A' },
  { kind: 'audioinput', deviceId: 'audio-a', label: 'Mic A' },
];

type IceServer = { urls: string | string[]; username?: string; credential?: string };

interface PageOpts {
  /** The join response's iceServers; absent when undefined. */
  iceServers?: IceServer[];
  /** The slot is return-only: the join has no whipUrl. */
  returnOnly?: boolean;
  /**
   * Each PeerConnection's iceGatheringState; 'complete' skips the gathering
   * wait. Set, the page's long timers (the gathering cap) fire at once.
   */
  gathering?: string;
}

interface Peer {
  role?: 'publish' | 'return';
  config: { iceServers?: IceServer[] };
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave', 'rejoin', 'device-alert']) {
    el(id).classList.add('hidden');
  }

  const requests: Array<{ method: string; url: string }> = [];
  const pcs: Peer[] = [];
  // The page's timer delays.
  const delays: number[] = [];
  const pageSetTimeout = (fn: () => void, ms = 0) => {
    delays.push(ms);
    return setTimeout(fn, opts.gathering && ms >= 1000 ? 0 : ms);
  };

  class RTCPeerConnection implements Peer {
    role: 'publish' | 'return' | undefined;
    iceGatheringState = opts.gathering ?? 'complete';
    connectionState = 'new';
    localDescription = { sdp: 'offer' };
    constructor(public config: { iceServers?: IceServer[] }) {
      // As a browser must (WebRTC §4.4.1.1): an unknown scheme is a SyntaxError,
      // a TURN URL without a username and credential an InvalidAccessError.
      for (const server of config?.iceServers ?? []) {
        for (const url of ([] as string[]).concat(server.urls)) {
          if (!/^(stuns?|turns?):/i.test(url)) throw Object.assign(new Error(`bad ICE url ${url}`), { name: 'SyntaxError' });
          if (/^turns?:/i.test(url) && (server.username === undefined || server.credential === undefined)) {
            throw Object.assign(new Error(`no credentials for ${url}`), { name: 'InvalidAccessError' });
          }
        }
      }
      pcs.push(this);
    }
    addTrack(t: FakeTrack) {
      this.role = 'publish';
      return { track: t, replaceTrack: () => Promise.resolve() };
    }
    addTransceiver() {
      this.role ??= 'return';
    }
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
    requests.push({ method, url });
    if (url.endsWith('/slot')) return respond(200, { returnOnly: !!opts.returnOnly });
    if (url.endsWith('/join')) {
      return respond(200, {
        ...(opts.returnOnly ? {} : { whipUrl: 'https://live.example.com/whip' }),
        returnOnly: !!opts.returnOnly,
        feeds: [{ id: 'picture', url: 'https://live.example.com/whep', video: true }],
        ...(opts.iceServers ? { iceServers: opts.iceServers } : {}),
      });
    }
    return respond(201, {}, '/whip/s1');
  };

  const getUserMedia = () =>
    Promise.resolve(new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]));

  const context = {
    document: { getElementById: el, createElement: () => new FakeElement() },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: { mediaDevices: { getUserMedia, enumerateDevices: () => Promise.resolve(DEVICES) } },
    window: { RTCPeerConnection, addEventListener: () => {} },
    RTCPeerConnection,
    MediaStream: FakeStream,
    fetch,
    URL,
    Promise,
    AbortController,
    setTimeout: pageSetTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(script, context);

  return {
    els,
    requests,
    delays,
    publishPc: () => pcs.find((p) => p.role === 'publish'),
    returnPc: () => pcs.find((p) => p.role === 'return'),
    published: () => requests.some((r) => r.method === 'POST' && r.url === 'https://live.example.com/whip'),
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

const STUN = { urls: 'stun:stun.l.google.com:19302' };
// Strom's shape: `urls` is one string.
const DEPLOYMENT: IceServer[] = [
  { urls: 'stun:stun.example.com:3478' },
  { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
];
// RTCIceServer also takes an array.
const DEPLOYMENT_ARRAYS: IceServer[] = [
  { urls: ['stun:stun.example.com:3478'] },
  { urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' },
];

describe('guest page ICE servers', () => {
  it("uses the join response's ICE servers for the publish and the return", async () => {
    for (const iceServers of [DEPLOYMENT, DEPLOYMENT_ARRAYS]) {
      const page = await goLive({ iceServers });
      expect(page.publishPc()!.config).toEqual({ iceServers });
      expect(page.returnPc()!.config).toEqual({ iceServers });
    }
  });

  it("gives a return-only slot's return the ICE servers", async () => {
    const page = await goLive({ iceServers: DEPLOYMENT, returnOnly: true });
    expect(page.published()).toBe(false);
    expect(page.publishPc()).toBeUndefined();
    expect(page.returnPc()!.config).toEqual({ iceServers: DEPLOYMENT });
  });

  it('keeps its STUN server when the join response has none', async () => {
    const page = await goLive();
    expect(page.publishPc()!.config).toEqual({ iceServers: [STUN] });
    expect(page.returnPc()!.config).toEqual({ iceServers: [STUN] });
  });

  it('drops a TURN entry without credentials, which the browser would reject, and goes live', async () => {
    const page = await goLive({
      iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: 'turn:turn.example.com:3478' }],
    });
    expect(page.publishPc()!.config).toEqual({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });
    expect(page.published()).toBe(true);
    expect(page.els['banner']!.className).toBe('live');
  });

  it('drops an uppercase TURN entry without credentials, as the browser parses the scheme case-insensitively', async () => {
    const page = await goLive({
      iceServers: [{ urls: 'stun:stun.example.com:3478' }, { urls: 'TURN:turn.example.com:3478' }],
    });
    expect(page.publishPc()!.config).toEqual({ iceServers: [{ urls: 'stun:stun.example.com:3478' }] });
    expect(page.published()).toBe(true);
  });

  it('falls back to its STUN server when the browser rejects the list, and goes live', async () => {
    const page = await goLive({ iceServers: [{ urls: 'bogus:turn.example.com' }] });
    expect(page.publishPc()!.config).toEqual({ iceServers: [STUN] });
    expect(page.published()).toBe(true);
    expect(page.els['banner']!.className).toBe('live');
  });

  it('waits longer for ICE gathering when there is a TURN server', async () => {
    for (const iceServers of [DEPLOYMENT, DEPLOYMENT_ARRAYS]) {
      const withTurn = await goLive({ iceServers, gathering: 'gathering' });
      expect(withTurn.published()).toBe(true);
      expect(withTurn.delays).toContain(6000);
    }

    const upperTurn = await goLive({
      iceServers: [{ urls: 'TURN:turn.example.com:3478', username: 'u', credential: 'p' }],
      gathering: 'gathering',
    });
    expect(upperTurn.delays).toContain(6000);

    const stunOnly = await goLive({ gathering: 'gathering' });
    expect(stunOnly.published()).toBe(true);
    expect(stunOnly.delays).toContain(2000);
    expect(stunOnly.delays).not.toContain(6000);
  });
});
