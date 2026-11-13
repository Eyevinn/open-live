/**
 * Strom's capabilities (GET /api/capabilities): parsing, and the
 * stale-while-revalidate cache. A cached answer is served at once and
 * refreshed in the background; only a lookup with nothing cached waits, and
 * only so long. A 404 (older Strom) is a definite "unsupported" (every mode,
 * no relay); other failures keep the last known values with
 * `state: 'unreachable'`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const capabilities = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { capabilities };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

const { StromClientError } = await import('../lib/strom.js');
const { getStromCapabilities, normaliseCapabilities, resetStromCapabilitiesCache, srtCapabilitiesFor, warmStromCapabilities } =
  await import('../services/strom-capabilities.js');

/** A Strom on a NAT'd network with two relays, as Strom serialises it. */
const BODY = {
  network: { inbound_reachable: false, ports: [{ first: 47100, last: 47199 }] },
  protocols: {
    srt: {
      modes: { listener: false, caller: true, rendezvous: false },
      relays: [
        { name: 'default', public: 'srt.example.com:9000' },
        { name: 'eu-north', public: 'srt-eu.example.com:9000' },
      ],
    },
    webrtc: { ice_servers: true, ice_transport_policy: 'all' },
  },
};

const OK = {
  state: 'ok',
  inboundReachable: false,
  ports: [{ first: 47100, last: 47199 }],
  srt: {
    modes: { listener: false, caller: true, rendezvous: false },
    relays: [
      { name: 'default', public: 'srt.example.com:9000' },
      { name: 'eu-north', public: 'srt-eu.example.com:9000' },
    ],
  },
  error: null,
};

const ALL_MODES = { listener: true, caller: true, rendezvous: true };
const NO_ANSWER = { inboundReachable: null, ports: null, srt: { modes: ALL_MODES, relays: [] }, error: null };

/** Let pending promise callbacks (a background refresh) run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('normaliseCapabilities', () => {
  it('reads the documented shape: modes, several relays, port spans', () => {
    expect(normaliseCapabilities(BODY)).toEqual(OK);
  });

  it('empty relays means no relay configured', () => {
    const body = { ...BODY, protocols: { ...BODY.protocols, srt: { ...BODY.protocols.srt, relays: [] } } };
    expect(normaliseCapabilities(body).srt.relays).toEqual([]);
  });

  it('ports null means any port', () => {
    expect(normaliseCapabilities({ ...BODY, network: { inbound_reachable: true, ports: null } })).toMatchObject({
      inboundReachable: true,
      ports: null,
    });
  });

  it('fails open: a mode is unsupported only when Strom says exactly false', () => {
    expect(normaliseCapabilities({}).srt.modes).toEqual(ALL_MODES);
    expect(normaliseCapabilities({ protocols: { srt: { modes: { listener: 0, caller: null } } } }).srt.modes).toEqual(ALL_MODES);
    expect(normaliseCapabilities(null)).toEqual({ state: 'ok', ...NO_ANSWER });
  });

  it('drops malformed relays and port spans, keeps the rest in order', () => {
    const caps = normaliseCapabilities({
      network: { ports: [{ first: 47100, last: 47101 }, { first: 5, last: 4 }, { first: 0, last: 1 }, 'x', { first: 48000, last: 48000 }] },
      protocols: {
        srt: {
          relays: [
            { name: 'default', public: ' srt.example.com:9000 ' },
            { name: 'Bad_Name', public: 'x:1' },
            { name: 'no-public' },
            { name: 'default', public: 'dup.example.com:9000' },
            'junk',
            { name: 'us', public: 'srt-us.example.com:9000' },
          ],
        },
      },
    });
    expect(caps.ports).toEqual([{ first: 47100, last: 47101 }, { first: 48000, last: 48000 }]);
    expect(caps.srt.relays).toEqual([
      { name: 'default', public: 'srt.example.com:9000' },
      { name: 'us', public: 'srt-us.example.com:9000' },
    ]);
  });
});

describe('getStromCapabilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    capabilities.mockReset();
    resetStromCapabilitiesCache();
  });
  afterEach(() => vi.useRealTimers());

  it('returns what Strom reports and keeps it fresh for ~30 s', async () => {
    capabilities.mockResolvedValue(BODY);
    expect(await getStromCapabilities()).toEqual(OK);
    vi.advanceTimersByTime(29_000);
    expect(await getStromCapabilities()).toEqual(OK);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('serves a stale answer at once and refreshes it in the background', async () => {
    capabilities.mockResolvedValueOnce(BODY);
    await getStromCapabilities();
    vi.advanceTimersByTime(31_000);
    // Strom now answers slowly: the request must not wait for it.
    let answer!: (v: unknown) => void;
    capabilities.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    expect(await getStromCapabilities()).toEqual(OK);
    await flush();
    expect(capabilities).toHaveBeenCalledTimes(2);
    // Concurrent stale reads share the one refresh.
    await getStromCapabilities();
    expect(capabilities).toHaveBeenCalledTimes(2);
    answer({ network: { inbound_reachable: true, ports: null }, protocols: { srt: { modes: ALL_MODES, relays: [] } } });
    await flush();
    expect(await getStromCapabilities()).toEqual({ state: 'ok', ...NO_ANSWER, inboundReachable: true });
  });

  it('the very first lookup waits, but only for a bounded time', async () => {
    capabilities.mockReturnValue(new Promise(() => {}));
    const first = getStromCapabilities();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toEqual({ state: 'unknown', ...NO_ANSWER });
  });

  it('warm-up at startup means the first request does not wait', async () => {
    capabilities.mockResolvedValue(BODY);
    warmStromCapabilities();
    await flush();
    capabilities.mockReturnValue(new Promise(() => {}));
    expect(await getStromCapabilities()).toEqual(OK);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    capabilities.mockResolvedValue(BODY);
    await Promise.all([getStromCapabilities(), getStromCapabilities(), getStromCapabilities()]);
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('a 404 (older Strom without capabilities) is unsupported: every mode, no relay, refreshed every 30 s', async () => {
    capabilities.mockRejectedValue(new StromClientError(404, 'Not Found'));
    expect(await getStromCapabilities()).toEqual({ state: 'unsupported', ...NO_ANSWER });
    vi.advanceTimersByTime(10_000);
    await getStromCapabilities();
    await flush();
    expect(capabilities).toHaveBeenCalledTimes(1);
  });

  it('Strom unreachable keeps the last known values, marked unreachable, and retries after 5 s', async () => {
    capabilities.mockResolvedValueOnce(BODY).mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    await getStromCapabilities();
    vi.advanceTimersByTime(31_000);
    await getStromCapabilities(); // stale: served, refresh kicked off (fails)
    await flush();
    const caps = await getStromCapabilities();
    expect(caps).toMatchObject({ state: 'unreachable', srt: OK.srt, ports: OK.ports, inboundReachable: false });
    expect(caps.error).toMatch(/Strom unreachable/);
    expect(capabilities).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    await getStromCapabilities();
    await flush();
    expect(capabilities).toHaveBeenCalledTimes(3);
  });

  it('Strom unreachable with nothing known offers every mode and no relay, marked unreachable', async () => {
    capabilities.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    const caps = await getStromCapabilities();
    expect(caps).toMatchObject({ state: 'unreachable', srt: { modes: ALL_MODES, relays: [] } });
    expect(caps.error).toMatch(/Strom unreachable/);
  });

  it('srtCapabilitiesFor only asks Strom when an SRT address is present', async () => {
    capabilities.mockResolvedValue(BODY);
    expect(await srtCapabilitiesFor(['https://example.com/x', undefined, null])).toBeUndefined();
    expect(capabilities).not.toHaveBeenCalled();
    expect(await srtCapabilitiesFor(['srt+relay://cam1'])).toEqual(OK);
    expect(await srtCapabilitiesFor(['srt://:47100?mode=listener'])).toEqual(OK);
  });
});
