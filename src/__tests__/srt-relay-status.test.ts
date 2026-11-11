/**
 * Strom's SRT relay status (GET /api/srt-relay): stale-while-revalidate. A
 * cached answer is served at once and refreshed in the background; only a
 * lookup with nothing cached waits, and only so long. A 404 (older Strom) is a
 * definite "not configured"; other failures keep the last known values with
 * `state: 'unreachable'`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const srtRelay = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { srtRelay };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

const { StromClientError } = await import('../lib/strom.js');
const { getSrtRelayStatus, resetSrtRelayStatusCache, srtRelayInfoFor, warmSrtRelayStatus } = await import('../services/srt-relay-status.js');

const CONFIGURED = { configured: true, relay: 'srt-splice:9000', public: 'relay.example.com:9000', error: null };
const OK = { ...CONFIGURED, state: 'ok' };

/** Let pending promise callbacks (a background refresh) run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('getSrtRelayStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    srtRelay.mockReset();
    resetSrtRelayStatusCache();
  });
  afterEach(() => vi.useRealTimers());

  it('returns what Strom reports and keeps it fresh for ~30 s', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    expect(await getSrtRelayStatus()).toEqual(OK);
    vi.advanceTimersByTime(29_000);
    expect(await getSrtRelayStatus()).toEqual(OK);
    expect(srtRelay).toHaveBeenCalledTimes(1);
  });

  it('serves a stale answer at once and refreshes it in the background', async () => {
    srtRelay.mockResolvedValueOnce(CONFIGURED);
    await getSrtRelayStatus();
    vi.advanceTimersByTime(31_000);
    // Strom now answers slowly: the request must not wait for it.
    let answer!: (v: unknown) => void;
    srtRelay.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    expect(await getSrtRelayStatus()).toEqual(OK);
    await flush();
    expect(srtRelay).toHaveBeenCalledTimes(2);
    // Concurrent stale reads share the one refresh.
    await getSrtRelayStatus();
    expect(srtRelay).toHaveBeenCalledTimes(2);
    answer({ configured: false, relay: null, public: null, error: null });
    await flush();
    expect(await getSrtRelayStatus()).toEqual({ configured: false, relay: null, public: null, error: null, state: 'ok' });
  });

  it('the very first lookup waits, but only for a bounded time', async () => {
    srtRelay.mockReturnValue(new Promise(() => {}));
    const first = getSrtRelayStatus();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await first).toEqual({ configured: false, relay: null, public: null, error: null, state: 'unknown' });
  });

  it('warm-up at startup means the first request does not wait', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    warmSrtRelayStatus();
    await flush();
    srtRelay.mockReturnValue(new Promise(() => {}));
    expect(await getSrtRelayStatus()).toEqual(OK);
    expect(srtRelay).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    await Promise.all([getSrtRelayStatus(), getSrtRelayStatus(), getSrtRelayStatus()]);
    expect(srtRelay).toHaveBeenCalledTimes(1);
  });

  it('a 404 (Strom without relay support) is a definite "not configured"', async () => {
    srtRelay.mockRejectedValue(new StromClientError(404, 'Not Found'));
    expect(await getSrtRelayStatus()).toEqual({ configured: false, relay: null, public: null, error: null, state: 'ok' });
  });

  it('normalises a partial answer', async () => {
    srtRelay.mockResolvedValue({ configured: true, public: '' });
    expect(await getSrtRelayStatus()).toEqual({ configured: true, relay: null, public: null, error: null, state: 'ok' });
  });

  it('Strom unreachable keeps the last known values, marked unreachable, and retries after 5 s', async () => {
    srtRelay.mockResolvedValueOnce(CONFIGURED).mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    await getSrtRelayStatus();
    vi.advanceTimersByTime(31_000);
    await getSrtRelayStatus(); // stale: served, refresh kicked off (fails)
    await flush();
    const status = await getSrtRelayStatus();
    expect(status).toMatchObject({ configured: true, public: 'relay.example.com:9000', state: 'unreachable' });
    expect(status.error).toMatch(/Strom unreachable/);
    expect(srtRelay).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    await getSrtRelayStatus();
    await flush();
    expect(srtRelay).toHaveBeenCalledTimes(3);
  });

  it('Strom unreachable with nothing known reads as unreachable, not as "not configured"', async () => {
    srtRelay.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    const status = await getSrtRelayStatus();
    expect(status).toMatchObject({ configured: false, public: null, state: 'unreachable' });
    expect(status.error).toMatch(/Strom unreachable/);
  });

  it('srtRelayInfoFor only asks Strom when a relay address is present', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    expect(await srtRelayInfoFor(['srt://:47100?mode=listener', undefined])).toBeUndefined();
    expect(srtRelay).not.toHaveBeenCalled();
    expect(await srtRelayInfoFor(['srt+relay://cam1'])).toEqual({ configured: true, public: 'relay.example.com:9000', state: 'ok' });
  });
});
