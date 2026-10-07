/**
 * The guest page's handling of its camera and microphone, run in a VM with fake
 * DOM, media devices and RTCPeerConnection (issue #468):
 *  - a published track that ends (device unplugged or taken) or is muted by
 *    the browser shows an alert naming the device, and the live banner stops
 *    saying the studio can see and hear the guest; unmute clears it;
 *  - "Reconnect" opens that device again and swaps it into the live
 *    connection with replaceTrack, with no new WHIP request, keeping the
 *    guest's mute;
 *  - the pickers stay while live and swap a device the same way;
 *  - a picked device that cannot be opened falls back to the default; when
 *    that fails too, the alert says so;
 *  - a device that cannot be swapped in is released, and a failed pick puts
 *    the connection back on the device in use;
 *  - a device already silent when the preview opens raises the alert;
 *  - the pickers show on a camera join, and keep showing the device in use
 *    after the list is rebuilt;
 *  - a page hidden before going live opens the devices again on a pick;
 *  - after leaving, nothing shows the alert or opens a device.
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
  // Only ever set to "" (clearing a <select>).
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
    // A <select> shows its first option unless one is marked selected.
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
  private listeners: Record<string, Array<() => void>> = {};
  constructor(public kind: 'audio' | 'video', public deviceId: string) {}
  getSettings() {
    return { deviceId: this.deviceId };
  }
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type: 'ended' | 'mute' | 'unmute') {
    if (type === 'mute') this.muted = true;
    if (type === 'unmute') this.muted = false;
    (this.listeners[type] ?? []).forEach((fn) => fn());
  }
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
  { kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' },
  { kind: 'videoinput', deviceId: 'cam-b', label: 'Cam B' },
  { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
  { kind: 'audioinput', deviceId: 'mic-b', label: 'Mic B' },
];

type Constraint = boolean | { deviceId: { exact: string } } | undefined;

interface PageOpts {
  /** Device ids getUserMedia refuses to open. */
  broken?: Set<string>;
  /** When set, every getUserMedia call fails. */
  denyAll?: () => boolean;
  /** When set, replaceTrack rejects. */
  replaceFails?: () => boolean;
  /** When set, replaceTrack waits until the test releases it. */
  holdReplace?: boolean;
  /** Device ids whose tracks open muted. */
  mutedAtOpen?: Set<string>;
  /** The slot check at page load answers return-only. */
  returnOnlyAtLoad?: boolean;
}

function runPage(script: string, opts: PageOpts = {}) {
  const els: Record<string, FakeElement> = {};
  const el = (id: string) => (els[id] ??= new FakeElement());
  for (const id of ['return', 'return-hint', 'return-mode', 'self-warning', 'mute', 'leave', 'device-alert']) {
    el(id).classList.add('hidden');
  }

  const requests: Array<{ method: string; url: string }> = [];
  const gumCalls: Array<{ audio?: Constraint; video?: Constraint }> = [];
  const replaced: Array<{ kind: string; track: FakeTrack }> = [];
  const senders: Record<string, { track: FakeTrack }> = {};
  const heldReplaces: Array<() => void> = [];
  const opened: FakeTrack[] = [];
  let denied = 0;
  const windowListeners: Record<string, Array<() => void>> = {};

  class RTCPeerConnection {
    iceGatheringState = 'complete';
    localDescription = { sdp: 'offer' };
    addTrack(t: FakeTrack) {
      const sender = {
        track: t,
        replaceTrack(next: FakeTrack) {
          if (opts.replaceFails?.()) return Promise.reject(new Error('InvalidStateError'));
          const apply = () => {
            sender.track = next;
            replaced.push({ kind: next.kind, track: next });
          };
          if (!opts.holdReplace) {
            apply();
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => heldReplaces.push(() => { apply(); resolve(); }));
        },
      };
      senders[t.kind] = sender;
      return sender;
    }
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
    requests.push({ method, url });
    if (url.endsWith('/slot')) return respond(200, { returnOnly: !!opts.returnOnlyAtLoad });
    if (url.endsWith('/join')) return respond(200, { whipUrl: 'https://live.example.com/whip', feeds: [] });
    return respond(201, {}, '/whip/s1');
  };

  const open = (kind: 'audio' | 'video', c: Constraint) => {
    const fallback = kind === 'audio' ? 'mic-a' : 'cam-a';
    const id = c && typeof c === 'object' ? c.deviceId.exact : fallback;
    if (opts.broken?.has(id)) return null;
    const t = new FakeTrack(kind, id);
    t.muted = !!opts.mutedAtOpen?.has(id);
    opened.push(t);
    return t;
  };

  const getUserMedia = (c: { audio?: Constraint; video?: Constraint }) => {
    gumCalls.push(c);
    if (opts.denyAll?.() || (denied > 0 && denied--)) return Promise.reject(new Error('NotAllowedError'));
    const tracks: FakeTrack[] = [];
    for (const kind of ['video', 'audio'] as const) {
      if (!c[kind]) continue;
      const t = open(kind, c[kind]);
      if (!t) return Promise.reject(new Error('OverconstrainedError'));
      tracks.push(t);
    }
    return Promise.resolve(new FakeStream(tracks));
  };

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

  const preview = () => el('preview').srcObject as FakeStream;
  return {
    els,
    requests,
    gumCalls,
    replaced,
    senders,
    /** The preview's current track of a kind. */
    track: (kind: 'audio' | 'video') => preview().getTracks().find((t) => t.kind === kind)!,
    /** Every track getUserMedia has opened. */
    opened,
    /** The next pick fails on both its tries (picked device, then default). */
    denyNext: () => { denied = 2; },
    releaseReplaces: () => heldReplaces.splice(0).forEach((fn) => fn()),
    fireWindow: (type: string) => (windowListeners[type] ?? []).forEach((fn) => fn()),
    whipPosts: () => requests.filter((r) => r.method === 'POST' && r.url.endsWith('/whip')).length,
    pick: (id: 'cam' | 'mic', value: string) => {
      el(id).value = value;
      el(id).fire('change');
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

async function boot(opts: PageOpts = {}) {
  const page = runPage(await pageScript(), opts);
  await flush();
  return page;
}

async function goLive(opts: PageOpts = {}) {
  const page = await boot(opts);
  page.els['golive']!.fire('click');
  await flush();
  return page;
}

describe('guest page devices', () => {
  it('alerts when the live microphone track ends', async () => {
    const page = await goLive();
    const { els } = page;
    expect(els['device-alert']!.hidden).toBe(true);

    page.track('audio').fire('ended');
    expect(els['device-alert']!.hidden).toBe(false);
    expect(els['device-alert-text']!.textContent).toMatch(/microphone stopped working/);
    expect(els['device-alert-text']!.textContent).toMatch(/cannot hear you/);
    expect(els['device-retry']!.textContent).toBe('Reconnect microphone');
    expect(els['banner']!.textContent).toBe('You are live.');
    expect(els['pickers']!.hidden).toBe(false);
  });

  it('names the camera, and both devices, when they end', async () => {
    const page = await goLive();
    page.track('video').fire('ended');
    expect(page.els['device-alert-text']!.textContent).toMatch(/Your camera stopped working\. The studio cannot see you/);
    page.track('audio').fire('ended');
    expect(page.els['device-alert-text']!.textContent).toMatch(/camera and microphone stopped working\. The studio cannot see or hear you/);
  });

  it('reconnects the microphone into the live connection without renegotiating, keeping mute', async () => {
    const page = await goLive();
    const { els } = page;
    els['mute']!.fire('click');
    const oldMic = page.track('audio');
    const cam = page.track('video');
    oldMic.fire('ended');

    els['device-retry']!.fire('click');
    await flush();

    expect(page.gumCalls.at(-1)).toEqual({ audio: { deviceId: { exact: 'mic-a' } } });
    const mic = page.track('audio');
    expect(mic).not.toBe(oldMic);
    expect(page.senders['audio']!.track).toBe(mic);
    expect(page.replaced.map((r) => r.kind)).toEqual(['audio']);
    expect(page.track('video')).toBe(cam);
    expect(mic.enabled).toBe(false);
    expect(oldMic.stopped).toBe(true);
    expect(page.whipPosts()).toBe(1);
    expect(els['device-alert']!.hidden).toBe(true);
    expect(els['banner']!.textContent).toBe('You are live. The studio can see and hear you.');
  });

  it('ignores an ended event from a track it has already replaced', async () => {
    const page = await goLive();
    const oldMic = page.track('audio');
    page.pick('mic', 'mic-b');
    await flush();
    oldMic.fire('ended');
    expect(page.els['device-alert']!.hidden).toBe(true);
  });

  it('swaps a device picked while live, leaving the other one alone', async () => {
    const page = await goLive();
    const mic = page.track('audio');
    page.pick('cam', 'cam-b');
    await flush();
    expect(page.track('video').deviceId).toBe('cam-b');
    expect(page.senders['video']!.track.deviceId).toBe('cam-b');
    expect(page.track('audio')).toBe(mic);
    expect(page.replaced.map((r) => r.kind)).toEqual(['video']);
    expect(page.whipPosts()).toBe(1);
    expect(page.els['cam']!.value).toBe('cam-b');
  });

  it('only uses the newest of two quick picks', async () => {
    const page = await goLive();
    page.pick('mic', 'mic-b');
    page.pick('mic', 'mic-a');
    await flush();
    expect(page.track('audio').deviceId).toBe('mic-a');
    expect(page.replaced).toHaveLength(1);
  });

  it('falls back to the default device when the picked one cannot be opened', async () => {
    const page = await goLive({ broken: new Set(['mic-b']) });
    page.pick('mic', 'mic-b');
    await flush();
    expect(page.track('audio').deviceId).toBe('mic-a');
    expect(page.senders['audio']!.track.deviceId).toBe('mic-a');
    expect(page.els['device-alert']!.hidden).toBe(true);
    expect(page.els['mic']!.value).toBe('mic-a');
  });

  it('says so when the device cannot be reconnected, and clears once it can', async () => {
    let deny = false;
    const page = await goLive({ denyAll: () => deny });
    page.track('audio').fire('ended');
    deny = true;
    page.els['device-retry']!.fire('click');
    await flush();
    expect(page.els['device-alert']!.hidden).toBe(false);
    expect(page.els['device-alert-text']!.textContent).toMatch(/Could not reconnect your microphone/);

    deny = false;
    page.els['device-retry']!.fire('click');
    await flush();
    expect(page.els['device-alert']!.hidden).toBe(true);
  });

  it('alerts while the browser mutes a track and clears on unmute', async () => {
    const page = await goLive();
    page.track('audio').fire('mute');
    expect(page.els['device-alert']!.hidden).toBe(false);
    page.track('audio').fire('unmute');
    expect(page.els['device-alert']!.hidden).toBe(true);
  });

  it('before going live, alerts without mentioning the studio and publishes the reconnected track', async () => {
    const page = await boot();
    page.track('audio').fire('ended');
    expect(page.els['device-alert-text']!.textContent).not.toMatch(/studio/);
    page.els['device-retry']!.fire('click');
    await flush();
    const mic = page.track('audio');
    expect(page.replaced).toHaveLength(0);

    page.els['golive']!.fire('click');
    await flush();
    expect(page.senders['audio']!.track).toBe(mic);
  });

  it('releases a new device that could not be swapped into the connection', async () => {
    let fail = false;
    const page = await goLive({ replaceFails: () => fail });
    const before = page.track('audio');
    fail = true;
    page.pick('mic', 'mic-b');
    await flush();
    expect(page.track('audio')).toBe(before);
    expect(page.senders['audio']!.track).toBe(before);
    expect(page.opened.filter((t) => t.deviceId === 'mic-b').every((t) => t.stopped)).toBe(true);
  });

  it('puts the connection back on the device in use when a newer pick fails', async () => {
    const page = await goLive({ holdReplace: true, broken: new Set(['mic-b']) });
    const before = page.track('audio');
    page.pick('mic', 'mic-a');
    await flush(); // the first pick is now waiting in replaceTrack
    // The second pick cannot open mic-b and falls back to the default (mic-a);
    // make that fail too.
    page.denyNext();
    page.pick('mic', 'mic-b');
    page.releaseReplaces();
    await flush();
    page.releaseReplaces();
    await flush();
    expect(page.track('audio')).toBe(before);
    expect(page.senders['audio']!.track).toBe(before);
    expect(before.stopped).toBe(false);
  });

  it('alerts when a device is already silent when the preview opens', async () => {
    const page = await boot({ mutedAtOpen: new Set(['cam-a']) });
    expect(page.els['device-alert']!.hidden).toBe(false);
    expect(page.els['device-alert-text']!.textContent).toMatch(/camera stopped working/);
  });

  it('shows the pickers when a slot that was return-only at page load joins with a camera', async () => {
    const page = await goLive({ returnOnlyAtLoad: true });
    expect(page.whipPosts()).toBe(1);
    expect(page.els['pickers']!.hidden).toBe(false);
  });

  it('reopens the devices on a pick after the page was hidden before going live', async () => {
    const page = await boot();
    const before = page.track('audio');
    page.fireWindow('pagehide');
    expect(before.stopped).toBe(true);
    page.pick('cam', 'cam-b');
    await flush();
    expect(page.track('audio').stopped).toBe(false);
    expect(page.track('video').deviceId).toBe('cam-b');
  });

  it('after leaving, shows no alert and opens no device', async () => {
    const page = await goLive();
    const mic = page.track('audio');
    page.els['leave']!.fire('click');
    await flush();
    const calls = page.gumCalls.length;
    mic.fire('ended');
    page.pick('mic', 'mic-b');
    await flush();
    expect(page.els['device-alert']!.hidden).toBe(true);
    expect(page.els['pickers']!.hidden).toBe(true);
    expect(page.gumCalls).toHaveLength(calls);
  });
});
