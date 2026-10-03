/**
 * The guest page's handling of the connection to the studio, run in a VM with a
 * fake DOM, media devices and RTCPeerConnection (issue #471):
 *  - the publish connection reaching "failed" replaces the live banner with a
 *    "connection lost" warning, hides Mute and offers Rejoin;
 *  - a "disconnected" publish connection shows a softer "reconnecting" notice
 *    and does not offer Rejoin yet; it restores the live banner on its own if
 *    it comes back "connected" within the grace window;
 *  - Rejoin joins and publishes again (reusing the invite's session) and puts
 *    the page back to live; it closes both return feeds and ends their WHEP
 *    sessions first;
 *  - the return connection failing only warns in the hint, leaving the live
 *    banner and the publish connection untouched; it clears when it recovers;
 *  - after leaving, a late connection-state change does nothing.
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
  get hidden() {
    return this.classes.has('hidden');
  }
}

let trackSeq = 0;
class FakeTrack {
  id = `t${++trackSeq}`;
  enabled = true;
  muted = false;
  stopped = false;
  constructor(public kind: 'audio' | 'video') {}
  getSettings() {
    return { deviceId: `${this.kind}-a` };
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

const DEVICES = [
  { kind: 'videoinput', deviceId: 'video-a', label: 'Cam A' },
  { kind: 'audioinput', deviceId: 'audio-a', label: 'Mic A' },
];

function runPage(script: string, opts: { fastFeed?: boolean } = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave', 'rejoin', 'device-alert']) {
    el(id).classList.add('hidden');
  }

  const requests: Array<{ method: string; url: string }> = [];
  const windowListeners: Record<string, Array<() => void>> = {};

  interface PeerState {
    connectionState: string;
    setState(state: string): void;
    role?: 'publish' | 'return';
    closed: boolean;
  }
  const pcs: PeerState[] = [];

  class RTCPeerConnection implements PeerState {
    connectionState = 'new';
    role: 'publish' | 'return' | undefined;
    closed = false;
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    private listeners: Record<string, Array<() => void>> = {};
    constructor() {
      pcs.push(this);
    }
    addTrack(t: FakeTrack) {
      this.role = 'publish';
      return { track: t, replaceTrack: () => Promise.resolve() };
    }
    addTransceiver() {
      this.role = 'return';
    }
    addEventListener(type: string, fn: () => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    setState(state: string) {
      this.connectionState = state;
      (this.listeners['connectionstatechange'] ?? []).forEach((fn) => fn());
    }
    createOffer() { return Promise.resolve({ type: 'offer', sdp: 'offer' }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    close() {
      this.closed = true;
    }
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
    if (url.endsWith('/slot')) return respond(200, { returnOnly: false });
    if (url.endsWith('/join')) {
      const feeds = [{ id: 'picture', url: 'https://live.example.com/returns/picture/whep' }];
      if (opts.fastFeed) feeds.push({ id: 'fast', url: 'https://live.example.com/returns/fast/whep' });
      return respond(200, { whipUrl: 'https://live.example.com/whip', feeds });
    }
    if (method === 'POST' && url.endsWith('/whep')) {
      const n = requests.filter((r) => r.method === 'POST' && r.url === url).length;
      return respond(201, {}, `${new URL(url).pathname}/s${n}`);
    }
    return respond(201, {}, '/whip/s1');
  };

  const getUserMedia = () =>
    Promise.resolve(new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]));

  const context = {
    document: { getElementById: el, createElement: () => new FakeElement() },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: { mediaDevices: { getUserMedia, enumerateDevices: () => Promise.resolve(DEVICES) } },
    window: {
      RTCPeerConnection,
      addEventListener: (type: string, fn: () => void) => (windowListeners[type] ??= []).push(fn),
    },
    RTCPeerConnection,
    MediaStream: FakeStream,
    fetch,
    URL,
    Promise,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(script, context);

  return {
    els,
    requests,
    publishPc: () => pcs.find((p) => p.role === 'publish'),
    pcs,
    returnPc: () => pcs.find((p) => p.role === 'return'),
    fireWindow: (type: string) => (windowListeners[type] ?? []).forEach((fn) => fn()),
    joinPosts: () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/join')).length,
    whipPosts: () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/whip')).length,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

async function goLive(opts: { fastFeed?: boolean } = {}) {
  const page = runPage(await pageScript(), opts);
  await flush();
  page.els['golive']!.fire('click');
  await flush();
  return page;
}

describe('guest page connection loss', () => {
  it('warns and offers Rejoin when the publish connection fails', async () => {
    const page = await goLive();
    expect(page.els['banner']!.textContent).toBe('You are live. The studio can see and hear you.');

    page.publishPc()!.setState('failed');
    expect(page.els['banner']!.textContent).toMatch(/Connection to the studio lost/);
    expect(page.els['banner']!.textContent).toMatch(/Rejoin/);
    expect(page.els['banner']!.className).toBe('error');
    expect(page.els['rejoin']!.hidden).toBe(false);
    expect(page.els['mute']!.hidden).toBe(true);
  });

  it('shows a softer notice while disconnected and recovers on its own', async () => {
    const page = await goLive();
    page.publishPc()!.setState('disconnected');
    expect(page.els['banner']!.textContent).toMatch(/Reconnecting to the studio/);
    // A disconnect that recovers must not have offered Rejoin.
    expect(page.els['rejoin']!.hidden).toBe(true);
    expect(page.els['mute']!.hidden).toBe(false);

    page.publishPc()!.setState('connected');
    expect(page.els['banner']!.textContent).toBe('You are live. The studio can see and hear you.');
  });

  it('rejoins the session and publishes again, returning to live', async () => {
    const page = await goLive();
    page.publishPc()!.setState('failed');
    expect(page.joinPosts()).toBe(1);
    expect(page.whipPosts()).toBe(1);

    page.els['rejoin']!.fire('click');
    await flush();

    expect(page.joinPosts()).toBe(2);
    expect(page.whipPosts()).toBe(2);
    expect(page.els['banner']!.textContent).toBe('You are live. The studio can see and hear you.');
    expect(page.els['rejoin']!.hidden).toBe(true);
    expect(page.els['mute']!.hidden).toBe(false);
  });

  it('closes both return feeds and ends their WHEP sessions on Rejoin', async () => {
    const page = await goLive({ fastFeed: true });
    const oldReturns = page.pcs.filter((p) => p.role === 'return');
    expect(oldReturns).toHaveLength(2);
    page.publishPc()!.setState('failed');

    page.els['rejoin']!.fire('click');
    await flush();

    expect(oldReturns.every((p) => p.closed)).toBe(true);
    const deletes = page.requests.filter((r) => r.method === 'DELETE').map((r) => r.url);
    expect(deletes).toEqual([
      'https://live.example.com/returns/picture/whep/s1',
      'https://live.example.com/returns/fast/whep/s1',
    ]);
    // Both feeds are played again on the new connection.
    expect(page.pcs.filter((p) => p.role === 'return' && !p.closed)).toHaveLength(2);
  });

  it('only warns in the hint when the return connection fails, leaving publish live', async () => {
    const page = await goLive();
    page.returnPc()!.setState('failed');
    expect(page.els['return-hint']!.textContent).toMatch(/Lost the return feed/);
    expect(page.els['banner']!.textContent).toBe('You are live. The studio can see and hear you.');
    expect(page.els['rejoin']!.hidden).toBe(true);

    page.returnPc()!.setState('connected');
    expect(page.els['return-hint']!.textContent).toBe('Return feed from the studio.');
  });

  it('ignores a connection-state change after the guest has left', async () => {
    const page = await goLive();
    page.els['leave']!.fire('click');
    await flush();
    expect(page.els['banner']!.textContent).toMatch(/You have left/);

    page.publishPc()!.setState('failed');
    expect(page.els['banner']!.textContent).toMatch(/You have left/);
    expect(page.els['rejoin']!.hidden).toBe(true);
  });
});
