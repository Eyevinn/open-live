/**
 * Strom SRT port lease — always active unless STROM_PORT_LEASE_DISABLED is set.
 *
 * Several Open Live instances share one cloud Strom. Listener SRT sources
 * (`srt://:PORT?mode=listener`) bind a port on that shared Strom, so each
 * instance reserves a contiguous port range up front and only accepts listener
 * sources inside it. The lease is acquired at boot, renewed on every tick, and
 * re-acquired under the same client id if Strom forgets it (e.g. a restart
 * without persistence). Strom instances without the API are detected and left
 * alone, with a low-frequency retry in case Strom gets upgraded underneath us.
 */

import os from 'os';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import type { PortLease } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';

const TICK_INTERVAL_MS = 60 * 1000;                 // renew / retry cadence
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;        // re-probe an old Strom every 10 min

export type PortLeaseState =
  | { status: 'leased'; lease: PortLease }
  | { status: 'pending' }
  | { status: 'unsupported' }
  | { status: 'disabled' };

/** The slice of StromClient the service needs — lets tests inject a fake. */
export type PortLeaseClient = Pick<StromClient, 'portLeases'>;
export type PortLeaseClientFactory = () => Promise<PortLeaseClient>;

export interface PortLeaseConfig {
  stromPortLeaseClientId?: string | undefined;
  publicBaseUrl?: string | undefined;
}

let state: PortLeaseState = config.stromPortLeaseDisabled ? { status: 'disabled' } : { status: 'pending' };
let unsupportedSince: number | null = null;
let leaseInterval: NodeJS.Timeout | null = null;
let inflightTick: Promise<void> | null = null;

const defaultClientFactory: PortLeaseClientFactory = async () => {
  const token = await getStromToken(config.stromToken);
  return new StromClient({ baseUrl: config.stromUrl, token });
};

let clientFactory: PortLeaseClientFactory = defaultClientFactory;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Lease client id: explicit override, else the hostname of PUBLIC_BASE_URL,
 * else `open-live-<os hostname>`. Must be stable across restarts so the same
 * instance gets its existing lease back.
 */
export function deriveClientId(cfg: PortLeaseConfig, hostname: string = os.hostname()): string {
  if (cfg.stromPortLeaseClientId) return cfg.stromPortLeaseClientId;
  if (cfg.publicBaseUrl) {
    try {
      const host = new URL(cfg.publicBaseUrl).hostname;
      if (host) return host;
    } catch {
      // fall through to the hostname default
    }
  }
  return `open-live-${hostname}`;
}

/**
 * Port of a hostless SRT listener address (`srt://:PORT[?...]`), or null for
 * anything else: caller form with a host, non-SRT schemes, or an explicit
 * non-listener mode. A hostless address with no `mode` parameter is treated
 * as a listener since it can only bind, never connect.
 */
export function parseListenerPort(address: string): number | null {
  const m = /^srt:\/\/:(\d{1,5})(?:\?([^#]*))?$/i.exec(address.trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const mode = new URLSearchParams(m[2] ?? '').get('mode');
  if (mode !== null && mode.toLowerCase() !== 'listener') return null;
  return port;
}

export function isPortInLease(port: number, lease: Pick<PortLease, 'first_port' | 'last_port'>): boolean {
  return port >= lease.first_port && port <= lease.last_port;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function getPortLease(): PortLeaseState {
  return state;
}

/**
 * A 404 from the lease routes. What it means depends on the call: on create,
 * nothing serves the routes at all (a Strom with no port broker proxied in
 * front of it), so leasing is unsupported here; on renew, the routes work but
 * this lease is gone, so it is re-acquired. The status is the whole signal
 * either way; the body is whatever the responder (Strom, a proxy) puts in it.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof StromClientError && err.status === 404;
}

async function acquire(log: FastifyBaseLogger): Promise<void> {
  const clientId = deriveClientId(config);
  try {
    const client = await clientFactory();
    const lease = await client.portLeases.acquire({ client_id: clientId, size: config.stromPortLeaseSize });
    const wasLeased = state.status === 'leased';
    state = { status: 'leased', lease };
    unsupportedSince = null;
    if (!wasLeased) {
      log.info(
        { clientId, leaseId: lease.id, firstPort: lease.first_port, lastPort: lease.last_port, expiresAt: lease.expires_at },
        '[port-lease] Acquired SRT port range from Strom',
      );
    }
  } catch (err) {
    if (isNotFound(err)) {
      // Create never 404s for any other reason: no broker answers here.
      if (state.status !== 'unsupported') {
        log.warn(
          { clientId },
          '[port-lease] Strom does not support port leases (POST /api/port-leases returned 404) — listener ports are not enforced. Will re-check every 10 min',
        );
      }
      state = { status: 'unsupported' };
      unsupportedSince = Date.now();
      return;
    }
    state = { status: 'pending' };
    log.warn({ err, clientId, size: config.stromPortLeaseSize }, '[port-lease] Failed to acquire SRT port range — will retry');
  }
}

async function renew(log: FastifyBaseLogger, current: PortLease): Promise<void> {
  try {
    const client = await clientFactory();
    const lease = await client.portLeases.renew(current.id);
    state = { status: 'leased', lease };
    log.debug({ leaseId: lease.id, expiresAt: lease.expires_at }, '[port-lease] Renewed SRT port lease');
  } catch (err) {
    if (isNotFound(err)) {
      // The routes answered, so a broker is there; only this lease is gone.
      log.warn({ leaseId: current.id }, '[port-lease] Lease vanished from Strom — re-acquiring under the same client id');
      state = { status: 'pending' };
      await acquire(log);
      // Read through the getter: TS does not see acquire() reassigning the module variable.
      const after = getPortLease();
      if (after.status === 'leased') {
        const fresh = after.lease;
        if (fresh.first_port !== current.first_port || fresh.last_port !== current.last_port) {
          log.warn(
            { previous: `${current.first_port}-${current.last_port}`, current: `${fresh.first_port}-${fresh.last_port}` },
            '[port-lease] Re-acquired a different port range — existing listener sources may be outside it',
          );
        }
      }
      return;
    }
    log.warn({ err, leaseId: current.id }, '[port-lease] Failed to renew SRT port lease — keeping last known range');
  }
}

/** One scheduler step: renew a held lease, otherwise (re)try acquisition. */
export async function tickPortLease(log: FastifyBaseLogger): Promise<void> {
  if (inflightTick) return inflightTick;
  inflightTick = (async () => {
    switch (state.status) {
      case 'disabled':
        return;
      case 'leased':
        await renew(log, state.lease);
        return;
      case 'unsupported':
        if (unsupportedSince !== null && Date.now() - unsupportedSince < UNSUPPORTED_RETRY_MS) return;
        await acquire(log);
        return;
      case 'pending':
        await acquire(log);
        return;
    }
  })().finally(() => {
    inflightTick = null;
  });
  return inflightTick;
}

export function startPortLease(log: FastifyBaseLogger): void {
  if (leaseInterval !== null) return;
  if (state.status === 'disabled') {
    log.info('[port-lease] SRT port leasing disabled (STROM_PORT_LEASE_DISABLED)');
    return;
  }

  log.info(
    { clientId: deriveClientId(config), size: config.stromPortLeaseSize, renewIntervalSec: TICK_INTERVAL_MS / 1000 },
    '[port-lease] SRT port leasing enabled',
  );

  void tickPortLease(log);

  leaseInterval = setInterval(() => {
    tickPortLease(log).catch((err) => log.error({ err }, '[port-lease] Tick error'));
  }, TICK_INTERVAL_MS);

  // Allow the process to exit even if the interval is still running
  leaseInterval.unref();
}

/** Stop renewing and release the lease (best effort) — for graceful shutdown. */
export async function stopPortLease(log: FastifyBaseLogger): Promise<void> {
  if (leaseInterval !== null) {
    clearInterval(leaseInterval);
    leaseInterval = null;
  }
  if (state.status !== 'leased') return;
  const { lease } = state;
  state = { status: 'pending' };
  try {
    const client = await clientFactory();
    await client.portLeases.release(lease.id);
    log.info({ leaseId: lease.id }, '[port-lease] Released SRT port lease');
  } catch (err) {
    log.warn({ err, leaseId: lease.id }, '[port-lease] Failed to release SRT port lease — it will expire on its own');
  }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Replace the Strom client used by the service. Pass null to restore the default. */
export function _setStromClientFactory(factory: PortLeaseClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

/** Reset module state between tests. */
export function _resetPortLeaseState(initial: PortLeaseState = { status: 'pending' }): void {
  if (leaseInterval !== null) {
    clearInterval(leaseInterval);
    leaseInterval = null;
  }
  state = initial;
  unsupportedSince = null;
  inflightTick = null;
}
