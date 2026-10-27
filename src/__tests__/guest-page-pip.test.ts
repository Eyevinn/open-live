/**
 * The guest page's picture-in-picture self view (issue #583), run in a VM with
 * fake DOM, fetch, RTCPeerConnection and localStorage (same approach as
 * guest-page-return-mode.test.ts):
 *  - the option is hidden before going live, shows once the return feed plays,
 *    and never shows on a return-only slot;
 *  - turning it on/off adds/removes the `.pip` layout and a corner class;
 *  - tapping the inset moves it clockwise through the corners;
 *  - the choice and corner persist in localStorage, and a throwing
 *    localStorage (Safari private mode) does not break the page;
 *  - leaving, closing the page and a lost return feed fall back to the stacked
 *    layout.
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

async function pageHtml(): Promise<string> {
  const app = Fastify();
  await app.register(guestPageRoutes);
  const res = await app.inject({ method: 'GET', url: '/guest/inv-1' });
  await app.close();
  return res.body;
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
  get hidden() {
    return this.classes.has('hidden');
  }
  has(c: string) {
    return this.classes.has(c);
  }
}

const PICTURE = { id: 'picture', url: 'https://live.example.com/api/v1/productions/p1/returns/in1/picture/whep', video: true };

interface PageOpts {
  /** The slot check answers `returnOnly: true` and join has no whipUrl. */
  returnOnly?: boolean;
  feeds?: unknown[];
  /** Backing store for localStorage; `'throws'` makes every access throw. */
  storage?: Map<string, string> | 'throws';
}

class FakePeerConnection {
  iceGatheringState = 'complete';
  localDescription = { sdp: 'offer' };
  connectionState = 'new';
  private listeners: Record<string, Array<() => void>> = {};
  addTrack() {}
  addTransceiver() {}
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
  close() {}
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  // Elements the page starts hidden.
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave', 'rejoin', 'pip-option', 'pip-hint']) {
    el(id).classList.add('hidden');
  }
  const peers: FakePeerConnection[] = [];
  class RTCPeerConnection extends FakePeerConnection {
    constructor() { super(); peers.push(this); }
  }

  const respond = (status: number, json: unknown, location: string | null = null) =>
    Promise.resolve({
      ok: status < 400,
      status,
      headers: { get: (h: string) => (h === 'Location' ? location : null) },
      json: () => Promise.resolve(json),
      text: () => Promise.resolve('answer'),
    });

  const fetch = (url: string) => {
    if (url.endsWith('/slot')) return respond(200, { returnOnly: !!opts.returnOnly });
    if (url.endsWith('/join')) {
      return respond(200, {
        whipUrl: opts.returnOnly ? undefined : 'https://live.example.com/whip',
        feeds: opts.feeds ?? [PICTURE],
        modes: [],
      });
    }
    return respond(201, {}, '/whip/s1');
  };

  const storage = opts.storage ?? new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => {
      if (storage === 'throws') throw new Error('SecurityError');
      return storage.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (storage === 'throws') throw new Error('QuotaExceededError');
      storage.set(k, v);
    },
  };

  const windowListeners: Record<string, Array<() => void>> = {};
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
    window: {
      RTCPeerConnection,
      localStorage,
      addEventListener(type: string, fn: () => void) { (windowListeners[type] ??= []).push(fn); },
    },
    RTCPeerConnection,
    fetch,
    URL,
    Promise,
    AbortController,
    setTimeout: (fn: () => void, ms: number) => (ms >= 5000 ? 0 : setTimeout(fn, ms)),
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  vm.runInNewContext(script, context);

  const videos = el('videos');
  return {
    els,
    peers,
    storage,
    videos,
    corner: () => ['tl', 'tr', 'br', 'bl'].filter((c) => videos.has(`pip-${c}`)),
    setPip: (on: boolean) => {
      el('pip-toggle').checked = on;
      el('pip-toggle').fire('change');
    },
    fireWindow: (type: string) => (windowListeners[type] ?? []).forEach((fn) => fn()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

async function loadPage(opts: PageOpts = {}) {
  const page = runPage(await pageScript(), opts);
  await flush();
  return page;
}

async function goLive(opts: PageOpts = {}) {
  const page = await loadPage(opts);
  page.els['golive']!.fire('click');
  await flush();
  return page;
}

describe('guest page picture-in-picture self view', () => {
  it('serves the toggle hidden and the return hint outside the video area', async () => {
    const html = await pageHtml();
    expect(html).toMatch(/<div id="pip-option" class="hidden">/);
    expect(html).toMatch(/<input type="checkbox" id="pip-toggle" \/> Show my camera as picture-in-picture/);
    const videos = /<div id="videos" class="videos">([\s\S]*?)<\/div>\s*<!--/.exec(html);
    expect(videos?.[1]).toContain('id="return"');
    expect(videos?.[1]).not.toContain('id="return-hint"');
  });

  it('is hidden before going live, even with the setting on', async () => {
    const { els, videos } = await loadPage({ storage: new Map([['openlive.guest.pip', '1']]) });
    expect(els['pip-option']!.hidden).toBe(true);
    expect(videos.has('pip')).toBe(false);
  });

  it('shows once the return feed plays, off by default (stacked layout)', async () => {
    const { els, videos } = await goLive();
    expect(els['return']!.hidden).toBe(false);
    expect(els['pip-option']!.hidden).toBe(false);
    expect(els['pip-toggle']!.checked).toBe(false);
    expect(videos.has('pip')).toBe(false);
    expect(els['pip-hint']!.hidden).toBe(true);
  });

  it('stays hidden when there is no return feed', async () => {
    const { els, videos } = await goLive({ feeds: [], storage: new Map([['openlive.guest.pip', '1']]) });
    expect(els['pip-option']!.hidden).toBe(true);
    expect(videos.has('pip')).toBe(false);
  });

  it('never shows on a return-only slot', async () => {
    const { els, videos } = await goLive({ returnOnly: true, storage: new Map([['openlive.guest.pip', '1']]) });
    expect(els['return']!.hidden).toBe(false);
    expect(els['pip-option']!.hidden).toBe(true);
    expect(videos.has('pip')).toBe(false);
  });

  it('turning it on and off adds and removes the layout classes', async () => {
    const { els, videos, corner, setPip } = await goLive();
    setPip(true);
    expect(videos.has('pip')).toBe(true);
    expect(corner()).toEqual(['br']);
    expect(els['pip-hint']!.hidden).toBe(false);
    setPip(false);
    expect(videos.has('pip')).toBe(false);
    expect(corner()).toEqual([]);
    expect(els['pip-hint']!.hidden).toBe(true);
  });

  it('tapping the inset moves it clockwise through the corners and saves the corner', async () => {
    const { els, corner, setPip, storage } = await goLive();
    const tap = () => els['preview']!.fire('click');
    tap(); // no effect while PiP is off
    expect(corner()).toEqual([]);
    setPip(true);
    const seen: string[][] = [];
    for (let i = 0; i < 4; i++) { tap(); seen.push(corner()); }
    expect(seen).toEqual([['bl'], ['tl'], ['tr'], ['br']]);
    tap();
    expect((storage as Map<string, string>).get('openlive.guest.pipCorner')).toBe('bl');
  });

  it('remembers the choice and corner for the next visit', async () => {
    const storage = new Map<string, string>();
    const first = await goLive({ storage });
    first.setPip(true);
    first.els['preview']!.fire('click'); // br -> bl
    expect(storage.get('openlive.guest.pip')).toBe('1');

    const second = await goLive({ storage });
    expect(second.els['pip-toggle']!.checked).toBe(true);
    expect(second.videos.has('pip')).toBe(true);
    expect(second.corner()).toEqual(['bl']);

    second.setPip(false);
    expect(storage.get('openlive.guest.pip')).toBe('0');
  });

  it('ignores a stored corner it does not know', async () => {
    const { corner } = await goLive({ storage: new Map([['openlive.guest.pip', '1'], ['openlive.guest.pipCorner', 'middle']]) });
    expect(corner()).toEqual(['br']);
  });

  it('still works when localStorage throws (Safari private mode)', async () => {
    const { els, videos, corner, setPip } = await goLive({ storage: 'throws' });
    expect(els['pip-option']!.hidden).toBe(false);
    expect(videos.has('pip')).toBe(false);
    setPip(true);
    expect(videos.has('pip')).toBe(true);
    els['preview']!.fire('click');
    expect(corner()).toEqual(['bl']);
    expect(els['banner']!.className).toBe('live');
  });

  it('leaving resets to the stacked layout', async () => {
    const { els, videos, corner, setPip } = await goLive();
    setPip(true);
    els['leave']!.fire('click');
    await flush();
    expect(videos.has('pip')).toBe(false);
    expect(corner()).toEqual([]);
    expect(els['pip-option']!.hidden).toBe(true);
  });

  it('closing the page resets to the stacked layout', async () => {
    const { els, videos, setPip, fireWindow } = await goLive();
    setPip(true);
    fireWindow('pagehide');
    expect(videos.has('pip')).toBe(false);
    expect(els['pip-option']!.hidden).toBe(true);
  });

  it('falls back to stacked while the return feed is lost, and back once it recovers', async () => {
    const { els, videos, peers, setPip } = await goLive();
    setPip(true);
    const returnPc = peers[peers.length - 1]!;
    returnPc.setState('failed');
    expect(videos.has('pip')).toBe(false);
    expect(els['pip-option']!.hidden).toBe(true);
    returnPc.setState('connected');
    expect(videos.has('pip')).toBe(true);
    expect(els['pip-option']!.hidden).toBe(false);
  });
});
