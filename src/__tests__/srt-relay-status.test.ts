/**
 * Strom's SRT relay status (GET /api/srt-relay), cached ~30 s. A 404 (older
 * Strom) reads as not configured; other failures serve the last good answer.
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
const { getSrtRelayStatus, resetSrtRelayStatusCache, srtRelayInfoFor } = await import('../services/srt-relay-status.js');

const CONFIGURED = { configured: true, relay: 'srt-splice:9000', public: 'relay.example.com:9000', error: null };

describe('getSrtRelayStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    srtRelay.mockReset();
    resetSrtRelayStatusCache();
  });
  afterEach(() => vi.useRealTimers());

  it('returns what Strom reports and caches it for ~30 s', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    expect(await getSrtRelayStatus()).toEqual(CONFIGURED);
    vi.advanceTimersByTime(29_000);
    expect(await getSrtRelayStatus()).toEqual(CONFIGURED);
    expect(srtRelay).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await getSrtRelayStatus();
    expect(srtRelay).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    await Promise.all([getSrtRelayStatus(), getSrtRelayStatus(), getSrtRelayStatus()]);
    expect(srtRelay).toHaveBeenCalledTimes(1);
  });

  it('a 404 (Strom without relay support) reads as not configured', async () => {
    srtRelay.mockRejectedValue(new StromClientError(404, 'Not Found'));
    expect(await getSrtRelayStatus()).toEqual({ configured: false, relay: null, public: null, error: null });
  });

  it('normalises a partial answer', async () => {
    srtRelay.mockResolvedValue({ configured: true, public: '' });
    expect(await getSrtRelayStatus()).toEqual({ configured: true, relay: null, public: null, error: null });
  });

  it('serves the last good answer when Strom fails, and an error without one', async () => {
    srtRelay.mockResolvedValueOnce(CONFIGURED).mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    await getSrtRelayStatus();
    vi.advanceTimersByTime(31_000);
    expect(await getSrtRelayStatus()).toEqual(CONFIGURED);

    resetSrtRelayStatusCache();
    const status = await getSrtRelayStatus();
    expect(status.configured).toBe(false);
    expect(status.error).toMatch(/Strom unreachable/);
  });

  it('srtRelayInfoFor only asks Strom when a relay address is present', async () => {
    srtRelay.mockResolvedValue(CONFIGURED);
    expect(await srtRelayInfoFor(['srt://:47100?mode=listener', undefined])).toBeUndefined();
    expect(srtRelay).not.toHaveBeenCalled();
    expect(await srtRelayInfoFor(['srt+relay://cam1'])).toEqual({ configured: true, public: 'relay.example.com:9000' });
  });
});
