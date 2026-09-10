/**
 * Tests for the Strom SRT port lease service.
 *
 * Pure helpers are tested directly. The acquire / renew / re-acquire cycle is
 * driven through tickPortLease() with a fake Strom client — no real Strom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { StromClientError } from '../lib/strom.js';
import type { PortLease } from '../lib/strom.js';
import {
  deriveClientId,
  parseListenerPort,
  isPortInLease,
  evaluateListenerPort,
  getPortLease,
  tickPortLease,
  stopPortLease,
  _setStromClientFactory,
  _resetPortLeaseState,
} from '../services/port-lease.js';

const LEASE: PortLease = {
  id: 'lease-1',
  client_id: 'open-live-test',
  first_port: 47100,
  last_port: 47119,
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('deriveClientId', () => {
  it('prefers the explicit override', () => {
    expect(deriveClientId({ stromPortLeaseClientId: 'custom', publicBaseUrl: 'https://live.example.com' }, 'box')).toBe('custom');
  });

  it('uses the hostname of PUBLIC_BASE_URL when set', () => {
    expect(deriveClientId({ publicBaseUrl: 'https://live.example.com:8443/base' }, 'box')).toBe('live.example.com');
  });

  it('falls back to open-live-<hostname> when PUBLIC_BASE_URL is unset', () => {
    expect(deriveClientId({}, 'box')).toBe('open-live-box');
  });

  it('falls back to open-live-<hostname> when PUBLIC_BASE_URL is not a URL', () => {
    expect(deriveClientId({ publicBaseUrl: 'not a url' }, 'box')).toBe('open-live-box');
  });
});

describe('parseListenerPort', () => {
  it('returns the port for a hostless listener address', () => {
    expect(parseListenerPort('srt://:47110?mode=listener')).toBe(47110);
    expect(parseListenerPort('srt://:47110?mode=listener&latency=200&passphrase=abc')).toBe(47110);
    expect(parseListenerPort('srt://:47110?latency=200&mode=listener')).toBe(47110);
  });

  it('treats a hostless address without a mode as a listener', () => {
    expect(parseListenerPort('srt://:47110')).toBe(47110);
    expect(parseListenerPort('srt://:47110?latency=200')).toBe(47110);
  });

  it('returns null for caller form with a host', () => {
    expect(parseListenerPort('srt://ingest.example.com:47110?mode=caller')).toBeNull();
    expect(parseListenerPort('srt://203.0.113.5:47110?mode=listener')).toBeNull();
  });

  it('returns null for hostless addresses with a non-listener mode', () => {
    expect(parseListenerPort('srt://:47110?mode=caller')).toBeNull();
    expect(parseListenerPort('srt://:47110?mode=rendezvous')).toBeNull();
  });

  it('returns null for non-SRT or malformed addresses', () => {
    expect(parseListenerPort('https://example.com/whip')).toBeNull();
    expect(parseListenerPort('srt://:0')).toBeNull();
    expect(parseListenerPort('srt://:70000')).toBeNull();
    expect(parseListenerPort('srt://')).toBeNull();
  });
});

describe('isPortInLease', () => {
  it('is inclusive at both ends', () => {
    expect(isPortInLease(47100, LEASE)).toBe(true);
    expect(isPortInLease(47119, LEASE)).toBe(true);
    expect(isPortInLease(47110, LEASE)).toBe(true);
  });

  it('rejects ports just outside the range', () => {
    expect(isPortInLease(47099, LEASE)).toBe(false);
    expect(isPortInLease(47120, LEASE)).toBe(false);
  });
});

describe('evaluateListenerPort', () => {
  it('passes non-listener addresses regardless of state', () => {
    expect(evaluateListenerPort('srt://ingest.example.com:9000?mode=caller', { status: 'pending' })).toEqual({ ok: true });
    expect(evaluateListenerPort('https://example.com/whip', { status: 'leased', lease: LEASE })).toEqual({ ok: true });
  });

  it('returns 422 naming the range for an out-of-range listener port', () => {
    const verdict = evaluateListenerPort('srt://:9000?mode=listener', { status: 'leased', lease: LEASE });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.statusCode).toBe(422);
    expect(verdict.error).toContain('47100-47119');
    expect(verdict.error).toContain('9000');
  });

  it('passes an in-range listener port', () => {
    expect(evaluateListenerPort('srt://:47105?mode=listener', { status: 'leased', lease: LEASE })).toEqual({ ok: true });
  });

  it('returns 503 while the lease is pending', () => {
    expect(evaluateListenerPort('srt://:47105?mode=listener', { status: 'pending' })).toEqual({
      ok: false,
      statusCode: 503,
      error: 'SRT port range not yet allocated from Strom, retry shortly',
    });
  });

  it('does not check when unsupported or disabled', () => {
    expect(evaluateListenerPort('srt://:9000?mode=listener', { status: 'unsupported' })).toEqual({ ok: true });
    expect(evaluateListenerPort('srt://:9000?mode=listener', { status: 'disabled' })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Service lifecycle with a fake Strom client
// ---------------------------------------------------------------------------

function makeLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    level: 'silent',
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log as unknown as FastifyBaseLogger;
}

function notFound(message = 'Lease not found'): StromClientError {
  return new StromClientError(404, message);
}

describe('port lease service', () => {
  const acquire = vi.fn();
  const renew = vi.fn();
  const release = vi.fn();
  let log: FastifyBaseLogger;

  beforeEach(() => {
    acquire.mockReset();
    renew.mockReset();
    release.mockReset();
    log = makeLog();
    _resetPortLeaseState({ status: 'pending' });
    _setStromClientFactory(async () => ({
      portLeases: { acquire, renew, release, list: vi.fn(), get: vi.fn() },
    }));
  });

  afterEach(() => {
    _setStromClientFactory(null);
    _resetPortLeaseState({ status: 'pending' });
  });

  it('acquires on the first tick, renews afterwards, and re-acquires when the renew 404s', async () => {
    acquire.mockResolvedValueOnce(LEASE);
    await tickPortLease(log);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]![0]).toMatchObject({ size: 20 });
    expect(getPortLease()).toEqual({ status: 'leased', lease: LEASE });
    const clientId = (acquire.mock.calls[0]![0] as { client_id: string }).client_id;
    expect(clientId).toMatch(/^open-live-/);

    // Second tick: renew, not acquire.
    const renewed = { ...LEASE, expires_at: '2026-01-01T00:20:00Z' };
    renew.mockResolvedValueOnce(renewed);
    await tickPortLease(log);
    expect(renew).toHaveBeenCalledWith(LEASE.id);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(getPortLease()).toEqual({ status: 'leased', lease: renewed });

    // Third tick: Strom forgot the lease — re-acquire with the same client id.
    const fresh = { ...LEASE, id: 'lease-2', first_port: 47200, last_port: 47219 };
    renew.mockRejectedValueOnce(notFound());
    acquire.mockResolvedValueOnce(fresh);
    await tickPortLease(log);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect((acquire.mock.calls[1]![0] as { client_id: string }).client_id).toBe(clientId);
    expect(getPortLease()).toEqual({ status: 'leased', lease: fresh });
    // Range changed — operators are warned.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ previous: '47100-47119', current: '47200-47219' }),
      expect.stringContaining('different port range'),
    );
  });

  it('stays pending and retries when acquisition fails', async () => {
    acquire.mockRejectedValueOnce(new StromClientError(409, 'pool exhausted'));
    await tickPortLease(log);
    expect(getPortLease()).toEqual({ status: 'pending' });
    expect(log.warn).toHaveBeenCalledTimes(1);

    acquire.mockResolvedValueOnce(LEASE);
    await tickPortLease(log);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(getPortLease()).toEqual({ status: 'leased', lease: LEASE });
  });

  it('keeps the last known range when a renew fails for a reason other than 404', async () => {
    acquire.mockResolvedValueOnce(LEASE);
    await tickPortLease(log);
    renew.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    await tickPortLease(log);
    expect(getPortLease()).toEqual({ status: 'leased', lease: LEASE });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('marks an old Strom as unsupported after one warning and stops trying', async () => {
    acquire.mockRejectedValue(new StromClientError(404, 'API endpoint not found'));
    await tickPortLease(log);
    expect(getPortLease()).toEqual({ status: 'unsupported' });
    expect(log.warn).toHaveBeenCalledTimes(1);

    // Subsequent ticks inside the 10 min back-off do not hit Strom again.
    await tickPortLease(log);
    await tickPortLease(log);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('treats any 404 on create as unsupported, whatever the body says', async () => {
    acquire.mockRejectedValue(new StromClientError(404, '<html>nginx: not found</html>'));
    await tickPortLease(log);
    expect(getPortLease()).toEqual({ status: 'unsupported' });
  });

  it('re-probes an unsupported Strom after the back-off window', async () => {
    vi.useFakeTimers();
    try {
      acquire.mockRejectedValueOnce(new StromClientError(404, 'API endpoint not found'));
      await tickPortLease(log);
      expect(getPortLease()).toEqual({ status: 'unsupported' });

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      acquire.mockResolvedValueOnce(LEASE);
      await tickPortLease(log);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(getPortLease()).toEqual({ status: 'leased', lease: LEASE });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    _resetPortLeaseState({ status: 'disabled' });
    await tickPortLease(log);
    expect(acquire).not.toHaveBeenCalled();
    expect(getPortLease()).toEqual({ status: 'disabled' });
  });

  it('releases the lease on stop and tolerates a failing release', async () => {
    acquire.mockResolvedValueOnce(LEASE);
    await tickPortLease(log);
    release.mockResolvedValueOnce(undefined);
    await stopPortLease(log);
    expect(release).toHaveBeenCalledWith(LEASE.id);
    expect(getPortLease()).toEqual({ status: 'pending' });

    // No lease held: nothing to release.
    await stopPortLease(log);
    expect(release).toHaveBeenCalledTimes(1);

    // Failing release must not throw.
    acquire.mockResolvedValueOnce(LEASE);
    await tickPortLease(log);
    release.mockRejectedValueOnce(notFound());
    await expect(stopPortLease(log)).resolves.toBeUndefined();
  });
});
