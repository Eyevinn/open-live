/**
 * Tests for the WebSocket CLIP_* command surface (epic #206, issue #278,
 * spec docs/specs/clip-story-playback.md).
 *
 * Covers:
 *  - the CLIP_CUE/PLAY/STOP/PAUSE/SEEK arms of the inbound zod schema (validation),
 *  - the handlers driving the Strom media-player block and broadcasting CLIP_STATE
 *    on every transition (cued/playing/paused/stopped),
 *  - the play-with-nothing-cued rejection (ERROR + CLIP_STATE error),
 *  - completion detection via the poll fallback (fake timers): while playing,
 *    when Strom reports `stopped` a CLIP_STATE `completed` is broadcast.
 *
 * CouchDB is mocked; a throwaway HTTP server stands in for Strom so the real
 * StromClient's player requests are asserted on the wire and player state is
 * controllable per test.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const productionDocs = new Map<string, Record<string, unknown>>();
const sourceDocs = new Map<string, Record<string, unknown>>();

const getProduction = vi.fn(async (id: string) => {
  const doc = productionDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});
const getSource = vi.fn(async (id: string) => {
  const doc = sourceDocs.get(id);
  if (!doc) throw new Error('not_found');
  return doc;
});

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: getProduction, insert: vi.fn().mockResolvedValue({ ok: true }), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getSourcesDb: () => ({ get: getSource, insert: vi.fn(), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
}));

const updateProductionDoc = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  // Emulate the real read-merge-write so clipCues accumulate on the doc mock,
  // letting the cue-persistence assertions observe the persisted map.
  const doc = productionDocs.get(id);
  if (doc) productionDocs.set(id, { ...doc, ...patch });
});
vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: (id: string, patch: Record<string, unknown>) => updateProductionDoc(id, patch),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const broadcasts: Array<Record<string, unknown>> = [];

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return {
    ...actual,
    broadcast: (_id: string, message: unknown) => {
      broadcasts.push(message as Record<string, unknown>);
    },
  };
});

// ---------------------------------------------------------------------------
// Throwaway Strom
// ---------------------------------------------------------------------------
interface StromRequest {
  method: string;
  path: string;
  body?: unknown;
}
const stromRequests: StromRequest[] = [];
let playerState: Record<string, unknown> = { state: 'stopped' };

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    stromRequests.push({ method: req.method ?? '', path: req.url ?? '', ...(raw ? { body: JSON.parse(raw) as unknown } : {}) });
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '').endsWith('/player/state')) res.end(JSON.stringify(playerState));
    else res.end(JSON.stringify({ success: true }));
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
process.env['STROM_URL'] = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
afterAll(() => stromServer.close());

// ---------------------------------------------------------------------------
// Clip URL preflight (issue #351): cueClip now does a real ranged-GET fetch
// against the clip's resolved URL before touching Strom. The fixture source
// address below is a public-looking hostname (required to pass httpUrlOnly's
// SSRF check — a loopback/private literal would be rejected there), so it is
// not actually reachable from the test sandbox. Intercept fetch ONLY for that
// exact URL and answer with a controllable status; everything else (the real
// StromClient traffic to the throwaway server above) passes through to the
// real fetch untouched.
// ---------------------------------------------------------------------------
const CLIP_URL = 'https://media.example.com/story-a.mp4';
// s3-reference presigned URLs resolve against this host (see MINIO_* env below).
const S3_HOST = 's3.example.test';
// A public-looking URL whose preflight answers a 302 (Location = redirectLocation),
// used to exercise the manual-redirect re-validation path.
const REDIRECT_URL = 'https://redirect.example.com/clip.mp4';
const realFetch = globalThis.fetch;
let clipUrlStatus = 200;
let s3Status = 200;
let redirectLocation: string | null = null;
// Records method + Range header of every intercepted preflight probe so tests
// can assert the probe is a ranged GET (never a HEAD — s3 presigned URLs are
// signed for GET only).
const preflightProbes: Array<{ url: string; method: string; range: string | null }> = [];
vi.spyOn(globalThis, 'fetch').mockImplementation(((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let host = '';
  try { host = new URL(url).host; } catch { /* non-URL input, leave blank */ }
  const method = (init?.method ?? 'GET').toUpperCase();
  const range = new Headers(init?.headers).get('range');
  if (url === CLIP_URL || url === REDIRECT_URL || host === S3_HOST) {
    preflightProbes.push({ url, method, range });
  }
  if (url === REDIRECT_URL && redirectLocation) {
    return Promise.resolve(new Response(null, { status: 302, headers: { location: redirectLocation } }));
  }
  if (url === CLIP_URL) return Promise.resolve(new Response(null, { status: clipUrlStatus }));
  if (host === S3_HOST) return Promise.resolve(new Response(null, { status: s3Status }));
  return realFetch(input as never, init);
}) as typeof fetch);
afterAll(() => { globalThis.fetch = realFetch; });

// Short stall-watchdog / cue-readiness timeouts so the new tests below don't
// have to wait out the production defaults (5s each).
process.env['CLIP_STALL_TIMEOUT_MS'] = '300';
process.env['CLIP_CUE_READY_TIMEOUT_MS'] = '300';

// Object storage config so `type: 's3'` clip references resolve to a presigned
// GET URL against S3_HOST (exercises the s3 preflight path, issue #351 review).
process.env['MINIO_ENDPOINT'] = S3_HOST;
process.env['MINIO_USE_SSL'] = 'true';
process.env['MINIO_ACCESS_KEY'] = 'test-access-key';
process.env['MINIO_SECRET_KEY'] = 'test-secret-key';
process.env['MINIO_BUCKET'] = 'clips';

const { handleMessage, clearClipStateForProduction } = await import('../ws/controller.js');
const { config } = await import('../config.js');

const PROD = 'prod-clip-ws01';
const FLOW = 'flow-clip-ws';
const BLOCK = 'b-clip-0-ws';

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Clip WS Test',
    status: 'active',
    stromFlowId: FLOW,
    clipPlayerBlockIds: { video_in_0: BLOCK },
    sources: [{ sourceId: 'src-clip', mixerInput: 'video_in_0' }],
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSourceDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'src-clip',
    type: 'source',
    name: 'Story A',
    address: JSON.stringify({ type: 'url', url: 'https://media.example.com/story-a.mp4' }),
    streamType: 'clip',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ws = { send: vi.fn() } as unknown as import('@fastify/websocket').WebSocket;

function send(msg: Record<string, unknown>) {
  return handleMessage(PROD, ws, JSON.stringify(msg), {});
}
function clipStates() {
  return broadcasts.filter((m) => m.type === 'CLIP_STATE');
}
function errorFrames() {
  return (ws.send as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map((c: unknown[]) => JSON.parse(c[0] as string) as Record<string, unknown>)
    .filter((m) => m.type === 'ERROR');
}
function playerReqs(suffix: string) {
  return stromRequests.filter((r) => r.path === `/api/flows/${FLOW}/blocks/${BLOCK}/player/${suffix}`);
}

beforeEach(() => {
  clearClipStateForProduction(PROD);
  broadcasts.length = 0;
  stromRequests.length = 0;
  playerState = { state: 'stopped' };
  clipUrlStatus = 200;
  s3Status = 200;
  redirectLocation = null;
  preflightProbes.length = 0;
  (ws.send as unknown as ReturnType<typeof vi.fn>).mockClear();
  updateProductionDoc.mockClear();
  productionDocs.clear();
  sourceDocs.clear();
  productionDocs.set(PROD, makeProductionDoc());
  sourceDocs.set('src-clip', makeSourceDoc());
});

describe('CLIP_* schema validation', () => {
  it('rejects CLIP_CUE with a bad mixerInput', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'nope' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('playlist')).toHaveLength(0);
  });
  it('rejects CLIP_SEEK with a negative positionMs', async () => {
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0', positionMs: -1 });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('seek')).toHaveLength(0);
  });
  it('rejects CLIP_SEEK missing positionMs', async () => {
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
  });
});

describe('CLIP_CUE / PLAY / PAUSE / STOP transitions', () => {
  it('CLIP_CUE sets playlist + gotos and broadcasts CLIP_STATE cued', async () => {
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    expect(errorFrames()).toHaveLength(0);
    expect(playerReqs('playlist')[0].body).toEqual({ files: ['https://media.example.com/story-a.mp4'] });
    expect(playerReqs('goto')[0].body).toEqual({ index: 0 });
    // Issue #350: Cue must park the clip at frame 0. Strom's setPlaylist/goto
    // start playback, so cueClip issues control({action:'stop'}) (= pause+seek0)
    // after the goto, in that order, before reading state.
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'stop' });
    const order = (suffix: string) => stromRequests.findIndex((r) => r.path === `/api/flows/${FLOW}/blocks/${BLOCK}/player/${suffix}`);
    expect(order('playlist')).toBeLessThan(order('goto'));
    expect(order('goto')).toBeLessThan(order('control'));
    const states = clipStates();
    expect(states.at(-1)).toMatchObject({ type: 'CLIP_STATE', mixerInput: 'video_in_0', state: 'cued', durationMs: 12000 });
  });

  it('CLIP_PLAY after cue broadcasts CLIP_STATE playing and controls play', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'playing', position_ns: 20_000_000, duration_ns: 12_000_000_000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'play' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'playing' });
  });

  it('CLIP_PLAY with nothing cued sends ERROR + CLIP_STATE error', async () => {
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'error' });
    expect(playerReqs('control')).toHaveLength(0);
  });

  it('CLIP_PAUSE controls pause and broadcasts paused', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'paused', position_ns: 500_000_000, duration_ns: 12_000_000_000 };
    await send({ type: 'CLIP_PAUSE', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'pause' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'paused' });
  });

  it('CLIP_STOP controls stop and broadcasts stopped', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'stopped', position_ns: 0 };
    await send({ type: 'CLIP_STOP', mixerInput: 'video_in_0' });
    expect(playerReqs('control').at(-1)?.body).toEqual({ action: 'stop' });
    expect(clipStates().at(-1)).toMatchObject({ state: 'stopped' });
  });

  it('CLIP_SEEK seeks and broadcasts state', async () => {
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'paused', position_ns: 5_000_000_000, duration_ns: 12_000_000_000 };
    await send({ type: 'CLIP_SEEK', mixerInput: 'video_in_0', positionMs: 5000 });
    expect(playerReqs('seek').at(-1)?.body).toEqual({ position_ns: 5_000_000_000 });
    expect(clipStates().length).toBeGreaterThan(0);
  });

  it('CLIP_CUE 404s (ERROR) when the source is not a clip source', async () => {
    sourceDocs.set('src-clip', makeSourceDoc({ streamType: 'srt', address: 'srt://1.2.3.4:9000' }));
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    expect(errorFrames().length).toBeGreaterThan(0);
    expect(playerReqs('playlist')).toHaveLength(0);
  });
});

describe('cue persistence (issue #307 / OQ3)', () => {
  function clipCuesCalls() {
    return updateProductionDoc.mock.calls.filter((c) => 'clipCues' in (c[1] as Record<string, unknown>));
  }

  it('CLIP_CUE persists the cue point to the production doc', async () => {
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    const call = clipCuesCalls().at(-1);
    expect(call).toBeDefined();
    const clipCues = (call![1] as { clipCues: Record<string, unknown> }).clipCues;
    expect(clipCues['video_in_0']).toMatchObject({ clipId: 'src-clip' });
  });

  it('CLIP_STOP clears the persisted cue', async () => {
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'stopped', position_ns: 0 };
    await send({ type: 'CLIP_STOP', mixerInput: 'video_in_0' });
    const lastClipCues = (clipCuesCalls().at(-1)![1] as { clipCues: Record<string, unknown> }).clipCues;
    expect(lastClipCues['video_in_0']).toBeUndefined();
  });
});

describe('completion poll fallback', () => {
  it('broadcasts CLIP_STATE completed one poll interval after Strom reports stopped', async () => {
    // The completion poll fires on a real setInterval and reads player state over
    // the wire (throwaway Strom); fake timers can't drive that real HTTP round
    // trip, so we let the poll run for real and wait it out. Latency is bounded
    // by one poll interval (config.clipStatePollMs).
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'playing', position_ns: 10_000_000, duration_ns: 8_000_000_000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    broadcasts.length = 0;

    // Strom now reports end-of-media.
    playerState = { state: 'stopped', position_ns: 8_000_000_000, duration_ns: 8_000_000_000 };

    // Wait until the poll observes `stopped` and broadcasts `completed` (or a
    // generous multiple of the poll interval elapses).
    const deadline = Date.now() + config.clipStatePollMs * 8 + 500;
    let completed: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      completed = clipStates().find((m) => m.state === 'completed');
      if (completed) break;
      await new Promise((r) => setTimeout(r, config.clipStatePollMs / 4 + 5));
    }

    expect(completed).toBeDefined();
    expect(completed).toMatchObject({ mixerInput: 'video_in_0', state: 'completed', durationMs: 8000 });
  });
});

// Regression coverage for issue #351: "Unfetchable clip URL gives the
// operator no error" — Cue reported CUED and Play reported PLAYING at
// 0:00/0:00 indefinitely because nothing checked the clip's media actually
// loaded. These three describe blocks cover the three fixes: a preflight
// reachability check at cue time, a post-cue readiness wait for a loaded
// duration, and a stalled-playhead watchdog while playing.
describe('clip URL preflight (issue #351)', () => {
  it('fails CLIP_CUE with CLIP_STATE error when the clip URL returns a non-2xx status', async () => {
    clipUrlStatus = 403;
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({
      mixerInput: 'video_in_0',
      state: 'error',
      error: 'Clip URL returned HTTP 403',
    });
    // The preflight must fail BEFORE the playlist is ever handed to Strom.
    expect(playerReqs('playlist')).toHaveLength(0);
    expect(playerReqs('goto')).toHaveLength(0);
  });

  it('cues normally when the clip URL preflight succeeds', async () => {
    clipUrlStatus = 200;
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames()).toHaveLength(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'cued', durationMs: 12000 });
    expect(playerReqs('playlist')).toHaveLength(1);
  });

  it('probes the clip URL with a ranged GET, never a HEAD', async () => {
    clipUrlStatus = 200;
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(preflightProbes.length).toBeGreaterThan(0);
    // A HEAD would 403 against a GET-presigned s3 URL (SignatureDoesNotMatch),
    // so the preflight must use a ranged GET for both url and s3 references.
    expect(preflightProbes.every((p) => p.method === 'GET')).toBe(true);
    expect(preflightProbes.at(-1)?.range).toBe('bytes=0-0');
  });
});

// s3 clip references (issue #351 review): resolveClipFile presigns a SigV4 GET
// URL (signed for GET only). The preflight must therefore probe with a ranged
// GET, not a HEAD — a HEAD would return 403 SignatureDoesNotMatch and fail the
// cue for every s3 clip. All other fixtures use type:'url', which is why this
// slipped CI, so these tests use an explicit s3 reference.
describe('clip URL preflight — s3 references (issue #351)', () => {
  const S3_ADDRESS = JSON.stringify({ type: 's3', bucket: 'clips', key: 'story/a.mp4' });

  it('cues an s3 reference by probing its presigned GET URL with a ranged GET', async () => {
    sourceDocs.set('src-clip', makeSourceDoc({ address: S3_ADDRESS }));
    s3Status = 200;
    playerState = { state: 'paused', duration_ns: 9_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames()).toHaveLength(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'cued', durationMs: 9000 });
    expect(playerReqs('playlist')).toHaveLength(1);
    // The presigned URL was actually probed, and with a ranged GET (not HEAD).
    const s3Probe = preflightProbes.find((p) => p.url.includes(S3_HOST));
    expect(s3Probe).toBeDefined();
    expect(s3Probe?.method).toBe('GET');
    expect(s3Probe?.range).toBe('bytes=0-0');
    // The playlist file handed to Strom is the presigned URL against the store.
    expect((playerReqs('playlist')[0].body as { files: string[] }).files[0]).toContain(`https://${S3_HOST}/clips/story/a.mp4`);
  });

  it('surfaces a non-2xx s3 object as a CLIP_STATE error before touching Strom', async () => {
    sourceDocs.set('src-clip', makeSourceDoc({ address: S3_ADDRESS }));
    s3Status = 404;
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'error', error: 'Clip URL returned HTTP 404' });
    expect(playerReqs('playlist')).toHaveLength(0);
  });
});

// SSRF via redirect on the new server-side fetch surface (issue #351 review):
// the preflight follows redirects manually and re-validates each Location with
// the same httpUrlOnly SSRF gate before following.
describe('clip URL preflight — redirect SSRF (issue #351)', () => {
  function useRedirectSource() {
    sourceDocs.set('src-clip', makeSourceDoc({ address: JSON.stringify({ type: 'url', url: REDIRECT_URL }) }));
  }

  it('blocks a redirect to a link-local metadata address and never cues', async () => {
    useRedirectSource();
    redirectLocation = 'http://169.254.169.254/latest/meta-data/';
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'error' });
    expect(String(clipStates().at(-1)?.error)).toContain('redirect blocked');
    // The internal target must never be fetched, and Strom must never be touched.
    expect(preflightProbes.some((p) => p.url.includes('169.254.169.254'))).toBe(false);
    expect(playerReqs('playlist')).toHaveLength(0);
  });

  it('follows a redirect to another allowed public URL after re-validating it', async () => {
    useRedirectSource();
    redirectLocation = CLIP_URL; // a re-validated, allowed public host
    clipUrlStatus = 200;
    playerState = { state: 'paused', duration_ns: 6_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames()).toHaveLength(0);
    expect(clipStates().at(-1)).toMatchObject({ state: 'cued', durationMs: 6000 });
    // Both hops were probed with a ranged GET.
    expect(preflightProbes.some((p) => p.url === REDIRECT_URL)).toBe(true);
    expect(preflightProbes.some((p) => p.url === CLIP_URL)).toBe(true);
    expect(preflightProbes.every((p) => p.method === 'GET')).toBe(true);
  });
});

describe('clip cue readiness timeout (issue #351)', () => {
  it('fails CLIP_CUE with CLIP_STATE error when Strom never reports a loaded duration', async () => {
    // Strom accepts the playlist/goto but never reports a non-zero duration —
    // exactly the async-load-never-completes case from the bug report.
    playerState = { state: 'paused', position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });

    expect(errorFrames().length).toBeGreaterThan(0);
    expect(clipStates().at(-1)).toMatchObject({
      mixerInput: 'video_in_0',
      state: 'error',
      error: 'Clip media could not be loaded',
    });
    // Unlike the preflight failure, setPlaylist/goto DID happen — Strom
    // accepted the load optimistically before failing to actually load it.
    expect(playerReqs('playlist')).toHaveLength(1);
  }, 10000);
});

describe('clip playback stall watchdog (issue #351)', () => {
  it('moves a playing clip to CLIP_STATE error when the position never advances', async () => {
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    // Strom reports `playing` (per the bug's root cause: state() is `playing`
    // whenever not paused and the playlist is non-empty) but the position
    // never moves off 0 — the pipeline never actually produced a frame.
    playerState = { state: 'playing', position_ns: 0, duration_ns: 12_000_000_000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    broadcasts.length = 0;

    const deadline = Date.now() + config.clipStallTimeoutMs + config.clipStatePollMs * 6 + 500;
    let errored: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      errored = clipStates().find((m) => m.state === 'error');
      if (errored) break;
      await new Promise((r) => setTimeout(r, config.clipStatePollMs / 4 + 5));
    }

    expect(errored).toBeDefined();
    expect(errored).toMatchObject({
      mixerInput: 'video_in_0',
      state: 'error',
      error: 'Clip playback stalled — position has not advanced',
    });
  }, 10000);

  it('does not error a playing clip whose position is advancing normally', async () => {
    playerState = { state: 'paused', duration_ns: 12_000_000_000, position_ns: 0 };
    await send({ type: 'CLIP_CUE', mixerInput: 'video_in_0' });
    playerState = { state: 'playing', position_ns: 100_000_000, duration_ns: 12_000_000_000 };
    await send({ type: 'CLIP_PLAY', mixerInput: 'video_in_0' });
    broadcasts.length = 0;

    // Advance the reported position on a tight interval — well under both the
    // poll cadence and the stall timeout — so the watchdog never observes two
    // consecutive poll ticks with an identical position.
    let positionMs = 100;
    const advance = setInterval(() => {
      positionMs += 40;
      playerState = { state: 'playing', position_ns: positionMs * 1_000_000, duration_ns: 12_000_000_000 };
    }, 40);
    try {
      await new Promise((r) => setTimeout(r, config.clipStallTimeoutMs + config.clipStatePollMs * 4));
    } finally {
      clearInterval(advance);
    }

    expect(clipStates().find((m) => m.state === 'error')).toBeUndefined();
  }, 10000);
});
