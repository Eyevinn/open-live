/**
 * The guest page's return-mode switch, run in a VM with fake DOM, fetch,
 * RTCPeerConnection and interval objects:
 *  - the switch shows once live, seeded from join's `returnMode`, and only when
 *    there is a return feed;
 *  - picking a mode PUTs it; a refused PUT puts the previous mode back;
 *  - "Full program" warns that the guest will hear themselves, except while muted;
 *  - the poll follows a change the crew made, but never undoes a newer local pick;
 *  - leaving stops the poll.
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
}

interface Request {
  method: string;
  url: string;
  body?: string;
}

const RETURN_URL = 'https://live.example.com/api/v1/guests/inv-1/session/return';
const PICTURE = { id: 'picture', url: 'https://live.example.com/api/v1/productions/p1/returns/in1/picture/whep', video: true };
const MODES = [
  { key: 'program', label: 'Program', synced: true, delivery: { kind: 'picture-switch' } },
  { key: 'program-minus', label: 'Program minus me', synced: true, excludesMixerInput: 'in1', delivery: { kind: 'picture-switch' } },
];

interface PageOpts {
  feeds?: unknown[];
  returnMode?: string;
  failPut?: boolean;
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  // Elements the page starts hidden.
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave']) el(id).classList.add('hidden');

  const requests: Request[] = [];
  const server = { mode: opts.returnMode ?? 'program-minus' };
  // GETs of the return mode wait here until the test releases them.
  const heldGets: Array<() => void> = [];
  let interval: (() => void) | null = null;

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

  const fetch = (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ method, url, body: init.body });
    if (url.endsWith('/join')) {
      return respond(200, {
        whipUrl: 'https://live.example.com/whip',
        feeds: opts.feeds ?? [PICTURE],
        modes: MODES,
        defaultMode: 'program-minus',
        returnMode: server.mode,
      });
    }
    if (url === RETURN_URL && method === 'PUT') {
      if (opts.failPut) return respond(500, { error: 'boom' });
      server.mode = JSON.parse(init.body ?? '{}').mode;
      return respond(200, { mixerInput: 'in1', mode: server.mode });
    }
    if (url === RETURN_URL) {
      const snapshot = server.mode;
      return new Promise((resolve) => {
        heldGets.push(() => resolve(respond(200, { mixerInput: 'in1', mode: snapshot, modes: MODES })));
      });
    }
    return respond(201, {}, '/whip/s1');
  };

  const track = { enabled: true, stop() {} };
  const context = {
    document: { getElementById: el, createElement: () => new FakeElement() },
    location: { pathname: '/guest/inv-1', hash: '#tok', origin: 'https://live.example.com' },
    navigator: {
      mediaDevices: {
        getUserMedia: () => Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track] }),
        enumerateDevices: () => Promise.resolve([]),
      },
    },
    window: { RTCPeerConnection, addEventListener() {} },
    RTCPeerConnection,
    fetch,
    URL,
    Promise,
    setTimeout,
    setInterval: (fn: () => void) => { interval = fn; return 1; },
    clearInterval: () => { interval = null; },
  };
  vm.runInNewContext(script, context);

  return {
    els,
    requests,
    server,
    /** Runs one poll tick, if polling. */
    tick: () => interval?.(),
    polling: () => interval !== null,
    releaseGets: () => heldGets.splice(0).forEach((r) => r()),
    pick: (mode: string) => {
      const input = el(`mode-${mode}`);
      input.checked = true;
      input.fire('change');
    },
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

describe('guest page return-mode switch', () => {
  it('shows once live, seeded from the join', async () => {
    const { els, polling } = await goLive({ returnMode: 'program-minus' });
    expect(els['return-mode']!.hidden).toBe(false);
    expect(els['mode-program-minus']!.checked).toBe(true);
    expect(els['mode-program']!.checked).toBe(false);
    expect(els['self-warning']!.hidden).toBe(true);
    expect(polling()).toBe(true);
  });

  it('stays hidden when the join lists no return feed', async () => {
    const { els, polling } = await goLive({ feeds: [] });
    expect(els['return-mode']!.hidden).toBe(true);
    expect(polling()).toBe(false);
  });

  it('PUTs the picked mode and warns about hearing yourself, except while muted', async () => {
    const { els, requests, pick } = await goLive();
    pick('program');
    await flush();
    const put = requests.find((r) => r.method === 'PUT' && r.url === RETURN_URL);
    expect(put?.body).toBe(JSON.stringify({ mode: 'program' }));
    expect(els['self-warning']!.hidden).toBe(false);

    els['mute']!.fire('click');
    expect(els['self-warning']!.hidden).toBe(true);
    els['mute']!.fire('click');
    expect(els['self-warning']!.hidden).toBe(false);

    pick('program-minus');
    await flush();
    expect(els['self-warning']!.hidden).toBe(true);
  });

  it('puts the previous mode back when the PUT is refused', async () => {
    const { els, pick } = await goLive({ failPut: true });
    pick('program');
    await flush();
    expect(els['mode-program-minus']!.checked).toBe(true);
    expect(els['mode-program']!.checked).toBe(false);
    expect(els['self-warning']!.hidden).toBe(true);
  });

  it('follows a mode change the crew made', async () => {
    const { els, server, tick, releaseGets } = await goLive();
    server.mode = 'program';
    tick();
    releaseGets();
    await flush();
    expect(els['mode-program']!.checked).toBe(true);
    expect(els['self-warning']!.hidden).toBe(false);
  });

  it('ignores a poll answer that started before the guest picked a mode', async () => {
    const { els, tick, releaseGets, pick } = await goLive();
    tick(); // reads program-minus, held
    pick('program');
    await flush();
    releaseGets();
    await flush();
    expect(els['mode-program']!.checked).toBe(true);
  });

  it('stops polling on leave', async () => {
    const { els, polling } = await goLive();
    els['leave']!.fire('click');
    await flush();
    expect(polling()).toBe(false);
    expect(els['return-mode']!.hidden).toBe(true);
  });
});
