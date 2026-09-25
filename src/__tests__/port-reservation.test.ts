/**
 * Tests for the Strom SRT port lease service.
 *
 * Pure helpers are tested directly. The acquire / renew / re-acquire cycle is
 * driven through tickPortReservation() with a fake Strom client — no real Strom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { StromClientError } from '../lib/strom.js';
import type { PortReservation } from '../lib/strom.js';
import {
  deriveOwnerId,
  parseListenerPort,
  isPortReserved,
  getPortReservation,
  tickPortReservation,
  stopPortReservation,
  _setStromClientFactory,
  _resetPortReservationState,
} from '../services/port-reservation.js';

const RESERVATION: PortReservation = {
  id: 'lease-1',
  owner_id: 'open-live-test',
  ports: [47100, 47101, 47102, 47103, 47104, 47105, 47106, 47107, 47108, 47109, 47110, 47111, 47112, 47113, 47114, 47115, 47116, 47117, 47118, 47119],
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('deriveOwnerId', () => {
  it('prefers the explicit override', () => {
    expect(deriveOwnerId({ stromPortLeaseClientId: 'custom', publicBaseUrl: 'https://live.example.com' }, 'box')).toBe('custom');
  });

  it('uses the hostname of PUBLIC_BASE_URL when set', () => {
    expect(deriveOwnerId({ publicBaseUrl: 'https://live.example.com:8443/base' }, 'box')).toBe('live.example.com');
  });

  it('falls back to open-live-<hostname> when PUBLIC_BASE_URL is unset', () => {
    expect(deriveOwnerId({}, 'box')).toBe('open-live-box');
  });

  it('falls back to open-live-<hostname> when PUBLIC_BASE_URL is not a URL', () => {
    expect(deriveOwnerId({ publicBaseUrl: 'not a url' }, 'box')).toBe('open-live-box');
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

describe('isPortReserved', () => {
  it('is inclusive at both ends', () => {
    expect(isPortReserved(47100, RESERVATION.ports)).toBe(true);
    expect(isPortReserved(47119, RESERVATION.ports)).toBe(true);
    expect(isPortReserved(47110, RESERVATION.ports)).toBe(true);
  });

  it('rejects ports just outside the range', () => {
    expect(isPortReserved(47099, RESERVATION.ports)).toBe(false);
    expect(isPortReserved(47120, RESERVATION.ports)).toBe(false);
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

describe('port reservation service', () => {
  const acquire = vi.fn();
  const renew = vi.fn();
  const release = vi.fn();
  const pool = vi.fn();
  let log: FastifyBaseLogger;

  beforeEach(() => {
    acquire.mockReset();
    renew.mockReset();
    release.mockReset();
    // Strom answers 409 both for "no pool configured" and "pool full", so the
    // service asks the pool endpoint to tell them apart. Default to a
    // configured pool; the tests that care override it.
    pool.mockReset();
    pool.mockResolvedValue({ enabled: true, ports: [], total: 0, free: 0, entries: [] });
    log = makeLog();
    _resetPortReservationState({ status: 'pending' });
    _setStromClientFactory(async () => ({
      ports: {
        pool,
        reservations: {
          create: acquire,
          renew,
          release,
          list: vi.fn(),
          get: vi.fn(),
          assign: vi.fn(),
          unassign: vi.fn(),
        },
      },
    }));
  });

  afterEach(() => {
    _setStromClientFactory(null);
    _resetPortReservationState({ status: 'pending' });
  });

  it('acquires on the first tick, renews afterwards, and re-acquires when the renew 404s', async () => {
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0]![0]).toMatchObject({ count: 10 });
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });
    const ownerId = (acquire.mock.calls[0]![0] as { owner_id: string }).owner_id;
    expect(ownerId).toMatch(/^open-live-/);

    // Second tick: renew, not acquire.
    const renewed = { ...RESERVATION, expires_at: '2026-01-01T00:20:00Z' };
    renew.mockResolvedValueOnce(renewed);
    await tickPortReservation(log);
    expect(renew).toHaveBeenCalledWith(RESERVATION.id);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: renewed });

    // Third tick: Strom forgot the reservation — take one again under the same
    // owner id.
    const fresh = { ...RESERVATION, id: 'reservation-2', ports: [47200, 47201] };
    renew.mockRejectedValueOnce(notFound());
    acquire.mockResolvedValueOnce(fresh);
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect((acquire.mock.calls[1]![0] as { owner_id: string }).owner_id).toBe(ownerId);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: fresh });
    // Ports we no longer hold are named, since sources may sit on them.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lost: RESERVATION.ports }),
      expect.stringContaining('Did not get every port back'),
    );
  });

  it('stays pending and retries when acquisition fails', async () => {
    acquire.mockRejectedValueOnce(new StromClientError(409, 'pool exhausted'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
    expect(log.warn).toHaveBeenCalledTimes(1);

    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });
  });

  it('falls back to unsupported after MAX_ACQUIRE_FAILURES consecutive inconclusive failures', async () => {
    acquire.mockRejectedValue(new StromClientError(503, 'proxy unavailable'));
    // First two failures stay pending — the state that blocks listener writes.
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
    // Third consecutive inconclusive failure gives up: unenforced (manual) ports.
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });
    expect(acquire).toHaveBeenCalledTimes(3);
    // The give-up warning is logged exactly once (distinct from the per-retry warnings).
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failures: 3 }),
      expect.stringContaining('Giving up reserving SRT listener ports'),
    );
  });

  it('resets the inconclusive failure counter after a successful acquire', async () => {
    acquire.mockRejectedValueOnce(new StromClientError(503, 'proxy unavailable'));
    acquire.mockRejectedValueOnce(new StromClientError(503, 'proxy unavailable'));
    await tickPortReservation(log);
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });

    // A success clears the counter, so a later failure starts counting from zero again.
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });

    // Renew 404s so we drop back to acquiring; two fresh failures must stay pending,
    // not tip straight into unsupported off the pre-success count.
    renew.mockRejectedValueOnce(notFound());
    acquire.mockRejectedValueOnce(new StromClientError(503, 'proxy unavailable'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
    acquire.mockRejectedValueOnce(new StromClientError(503, 'proxy unavailable'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
  });

  it('keeps a failed re-probe in unsupported rather than dropping into pending', async () => {
    // Get to unsupported via a clean 404.
    acquire.mockRejectedValueOnce(new StromClientError(404, 'API endpoint not found'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });

    // A non-404 failure on the re-probe (after the back-off) must not block writes.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      acquire.mockRejectedValueOnce(new StromClientError(503, 'proxy unavailable'));
      await tickPortReservation(log);
      expect(getPortReservation()).toEqual({ status: 'unsupported' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the last known ports when a renew fails for a reason other than 404 or a lost pool', async () => {
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    renew.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('marks an old Strom as unsupported after one warning and stops trying', async () => {
    acquire.mockRejectedValue(new StromClientError(404, 'API endpoint not found'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });
    expect(log.warn).toHaveBeenCalledTimes(1);

    // Subsequent ticks inside the 10 min back-off do not hit Strom again.
    await tickPortReservation(log);
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('marks a Strom with no port pool configured as unsupported, and says so', async () => {
    // Strom answers 409 both for "no pool configured" and "pool full", so the
    // status alone cannot decide; the pool endpoint does. It must not be
    // treated as a transient failure: retrying every minute would never
    // succeed, and `pending` blocks every listener write.
    pool.mockResolvedValue({ enabled: false, ports: [], total: 0, free: 0, entries: [] });
    acquire.mockRejectedValue(
      new StromClientError(409, 'no port pool is configured on this Strom; set ports.ports or STROM_PORTS'),
    );
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    // The warning has to name the setting; a 501 and a 404 need different fixes.
    const [, message] = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(message).toContain('STROM_PORTS');

    // Still inside the back-off, so no further calls.
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying when the pool exists but has nothing free', async () => {
    // The other meaning of 409. An operator can grow the pool, or another
    // owner can give ports back, so this must stay `pending` and retry rather
    // than switching enforcement off.
    pool.mockResolvedValue({ enabled: true, ports: [], total: 10, free: 0, entries: [] });
    acquire.mockRejectedValue(new StromClientError(409, 'only 0 ports free in the pool, 10 requested'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'pending' });
    await tickPortReservation(log);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('drops the restriction when the pool is taken away under a live reservation', async () => {
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });

    // A 409 on renew against a pool that reports itself disabled is not "this
    // reservation is gone" (that is 404) — the pool itself is gone, so
    // re-reserving would 409 forever.
    pool.mockResolvedValue({ enabled: false, ports: [], total: 0, free: 0, entries: [] });
    renew.mockRejectedValueOnce(new StromClientError(409, 'no port pool is configured on this Strom'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });
    expect(acquire).toHaveBeenCalledTimes(1);

    // And the 10-minute re-probe picks the range back up once a pool returns.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      pool.mockResolvedValue({ enabled: true, ports: [], total: 10, free: 10, entries: [] });
      acquire.mockResolvedValueOnce(RESERVATION);
      await tickPortReservation(log);
      expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats any 404 on create as unsupported, whatever the body says', async () => {
    acquire.mockRejectedValue(new StromClientError(404, '<html>nginx: not found</html>'));
    await tickPortReservation(log);
    expect(getPortReservation()).toEqual({ status: 'unsupported' });
  });

  it('re-probes an unsupported Strom after the back-off window', async () => {
    vi.useFakeTimers();
    try {
      acquire.mockRejectedValueOnce(new StromClientError(404, 'API endpoint not found'));
      await tickPortReservation(log);
      expect(getPortReservation()).toEqual({ status: 'unsupported' });

      vi.advanceTimersByTime(10 * 60 * 1000 + 1);
      acquire.mockResolvedValueOnce(RESERVATION);
      await tickPortReservation(log);
      expect(acquire).toHaveBeenCalledTimes(2);
      expect(getPortReservation()).toEqual({ status: 'reserved', reservation: RESERVATION });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing when disabled', async () => {
    _resetPortReservationState({ status: 'disabled' });
    await tickPortReservation(log);
    expect(acquire).not.toHaveBeenCalled();
    expect(getPortReservation()).toEqual({ status: 'disabled' });
  });

  it('releases the lease on stop and tolerates a failing release', async () => {
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    release.mockResolvedValueOnce(undefined);
    await stopPortReservation(log);
    expect(release).toHaveBeenCalledWith(RESERVATION.id);
    expect(getPortReservation()).toEqual({ status: 'pending' });

    // No lease held: nothing to release.
    await stopPortReservation(log);
    expect(release).toHaveBeenCalledTimes(1);

    // Failing release must not throw.
    acquire.mockResolvedValueOnce(RESERVATION);
    await tickPortReservation(log);
    release.mockRejectedValueOnce(notFound());
    await expect(stopPortReservation(log)).resolves.toBeUndefined();
  });
});
