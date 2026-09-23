/**
 * SRT listener ports reserved from Strom's port pool.
 *
 * Several Open Live instances share one cloud Strom. Listener SRT sources
 * (`srt://:PORT?mode=listener`) bind a port on that shared Strom, so each
 * instance reserves a set of ports up front and only accepts listener sources
 * and outputs on ports it holds. The reservation is taken at boot, renewed on
 * every tick, and re-taken under the same owner id if Strom forgets it (e.g. a
 * restart without persistence). Strom never moves the ports an owner already
 * holds, so a restart keeps the numbers gateways are configured to dial.
 *
 * Strom hands out ports only once an operator configures a pool. A Strom that
 * will not is detected and left alone, with a low-frequency retry, since both
 * reasons for it are things an operator can change underneath us: no pool
 * configured, or a Strom too old to have the routes at all.
 */

import os from 'os';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { StromClient, StromClientError } from '../lib/strom.js';
import type { PortReservation } from '../lib/strom.js';
import { getStromToken } from '../lib/strom-token.js';

const TICK_INTERVAL_MS = 60 * 1000;                 // renew / retry cadence
const UNSUPPORTED_RETRY_MS = 10 * 60 * 1000;        // re-probe a non-reserving Strom every 10 min
const MAX_ACQUIRE_FAILURES = 3;                     // consecutive inconclusive failures before giving up

export type PortReservationState =
  | { status: 'reserved'; reservation: PortReservation }
  | { status: 'pending' }
  | { status: 'unsupported' }
  | { status: 'disabled' };

/** The slice of StromClient the service needs — lets tests inject a fake. */
export type PortReservationClient = Pick<StromClient, 'ports'>;
export type PortReservationClientFactory = () => Promise<PortReservationClient>;

/**
 * The logging a flow association needs. Narrower than `FastifyBaseLogger`,
 * which it satisfies, so the flow generator can pass a console adapter without
 * a request-scoped logger in hand.
 */
export interface PortLog {
  debug: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
}

export interface PortReservationConfig {
  stromPortLeaseClientId?: string | undefined;
  publicBaseUrl?: string | undefined;
}

let state: PortReservationState = config.stromPortLeaseDisabled ? { status: 'disabled' } : { status: 'pending' };
let unsupportedSince: number | null = null;
let consecutiveAcquireFailures = 0;
let tickInterval: NodeJS.Timeout | null = null;
let inflightTick: Promise<void> | null = null;

const defaultClientFactory: PortReservationClientFactory = async () => {
  const token = await getStromToken(config.stromToken);
  return new StromClient({ baseUrl: config.stromUrl, token });
};

let clientFactory: PortReservationClientFactory = defaultClientFactory;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Owner id: explicit override, else the hostname of PUBLIC_BASE_URL, else
 * `open-live-<os hostname>`. Must be stable across restarts so the same
 * instance gets its existing ports back.
 */
export function deriveOwnerId(cfg: PortReservationConfig, hostname: string = os.hostname()): string {
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

/** Whether this instance holds `port`. Strom's set may have holes, so this is membership, not a range test. */
export function isPortReserved(port: number, ports: readonly number[]): boolean {
  return ports.includes(port);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function getPortReservation(): PortReservationState {
  return state;
}

/** The ports this instance holds, or an empty list when it holds none. */
export function reservedPorts(): number[] {
  return state.status === 'reserved' ? state.reservation.ports : [];
}

/**
 * A 404 from the pool routes: this server has no such route. On create that
 * means nothing serves them at all — a Strom older than the pool, or something
 * else on `STROM_URL`. On renew it means the routes work but this reservation
 * is gone, so it is taken again.
 */
function isNotFound(err: unknown): boolean {
  return err instanceof StromClientError && err.status === 404;
}

/**
 * A 409 from the pool routes. Strom uses it for two different things — no pool
 * configured, and a pool with nothing free — which need opposite reactions:
 * the first should stop enforcing, the second should keep retrying. The status
 * alone cannot tell them apart, so `GET /api/ports` is asked; it answers on an
 * unconfigured server too, which is the whole reason it exists.
 */
function isConflict(err: unknown): boolean {
  return err instanceof StromClientError && err.status === 409;
}

/** Whether Strom says it has no pool at all. Unreachable counts as "cannot tell". */
async function poolIsUnconfigured(client: PortReservationClient): Promise<boolean> {
  try {
    return (await client.ports.pool()).enabled === false;
  } catch {
    return false;
  }
}

function fallBackToUnsupported(log: FastifyBaseLogger, message: string, fields: object): void {
  if (state.status !== 'unsupported') log.warn(fields, message);
  state = { status: 'unsupported' };
  unsupportedSince = Date.now();
  consecutiveAcquireFailures = 0;
}

async function acquire(log: FastifyBaseLogger): Promise<void> {
  const ownerId = deriveOwnerId(config);
  let client: PortReservationClient | null = null;
  try {
    client = await clientFactory();
    const reservation = await client.ports.reservations.create({
      owner_id: ownerId,
      count: config.stromPortLeaseSize,
    });
    const wasReserved = state.status === 'reserved';
    state = { status: 'reserved', reservation };
    unsupportedSince = null;
    consecutiveAcquireFailures = 0;
    if (!wasReserved) {
      log.info(
        { ownerId, reservationId: reservation.id, ports: reservation.ports, expiresAt: reservation.expires_at },
        '[ports] Reserved SRT listener ports from Strom',
      );
    }
  } catch (err) {
    if (isNotFound(err)) {
      fallBackToUnsupported(
        log,
        '[ports] Strom has no port pool API (POST /api/ports/reservations returned 404) — listener ports are not enforced. Will re-check every 10 min',
        { ownerId },
      );
      return;
    }
    if (isConflict(err) && client && (await poolIsUnconfigured(client))) {
      fallBackToUnsupported(
        log,
        '[ports] Strom has no port pool configured — listener ports are not enforced. Set STROM_PORTS on Strom if several Open Live instances share it. Will re-check every 10 min',
        { ownerId },
      );
      return;
    }
    if (isConflict(err)) {
      // A pool that exists but has nothing left. Retrying is the right move:
      // an operator can grow it, or another owner can give ports back.
      state = { status: 'pending' };
      log.warn(
        { err, ownerId, count: config.stromPortLeaseSize },
        '[ports] Strom has no free ports left in its pool — will retry. Grow the pool or release a decommissioned instance',
      );
      return;
    }
    // Anything else is ambiguous: a proxy 502/503, a gateway 405, a 401/403, a
    // timeout, DNS, or a client-construction error. Unlike a clean 404 or a
    // 409 with a disabled pool it does not prove this Strom will not reserve,
    // so we do not switch the restriction off on the first try. But `pending`
    // blocks all listener writes, so it must not persist indefinitely (#294):
    // after MAX_ACQUIRE_FAILURES consecutive inconclusive failures, fall back
    // to `unsupported` — manual ports, no restriction — which the 10-min
    // re-probe can still recover from. Failures while already `unsupported` (a
    // failed re-probe) stay `unsupported` rather than dropping into the
    // write-blocking `pending` state.
    consecutiveAcquireFailures += 1;
    if (state.status === 'unsupported' || consecutiveAcquireFailures >= MAX_ACQUIRE_FAILURES) {
      fallBackToUnsupported(
        log,
        '[ports] Giving up reserving SRT listener ports after repeated inconclusive failures — falling back to unenforced (manual) ports. Will re-check every 10 min',
        { err, ownerId, failures: consecutiveAcquireFailures },
      );
      return;
    }
    state = { status: 'pending' };
    log.warn(
      { err, ownerId, count: config.stromPortLeaseSize, failures: consecutiveAcquireFailures },
      '[ports] Failed to reserve SRT listener ports — will retry',
    );
  }
}

async function renew(log: FastifyBaseLogger, current: PortReservation): Promise<void> {
  let client: PortReservationClient | null = null;
  try {
    client = await clientFactory();
    const reservation = await client.ports.reservations.renew(current.id);
    state = { status: 'reserved', reservation };
    log.debug({ reservationId: reservation.id, expiresAt: reservation.expires_at }, '[ports] Renewed SRT port reservation');
  } catch (err) {
    if (isConflict(err) && client && (await poolIsUnconfigured(client))) {
      // The pool was taken away under us. Re-reserving would 409 on every
      // tick, so stop enforcing and let the 10-minute re-probe pick the ports
      // back up once a pool returns.
      fallBackToUnsupported(
        log,
        '[ports] Strom no longer has a port pool configured — listener ports are no longer enforced. Will re-check every 10 min',
        { reservationId: current.id },
      );
      return;
    }
    if (isNotFound(err)) {
      // The routes answered, so this Strom does reserve; only this reservation
      // is gone.
      log.warn({ reservationId: current.id }, '[ports] Reservation vanished from Strom — taking one again under the same owner id');
      state = { status: 'pending' };
      await acquire(log);
      // Read through the getter: TS does not see acquire() reassigning the module variable.
      const after = getPortReservation();
      if (after.status === 'reserved') {
        const fresh = after.reservation.ports;
        const gone = current.ports.filter((p) => !fresh.includes(p));
        if (gone.length > 0) {
          log.warn(
            { previous: current.ports, current: fresh, lost: gone },
            '[ports] Did not get every port back — existing listener sources on the lost ports are now outside this instance\'s set',
          );
        }
      }
      return;
    }
    log.warn({ err, reservationId: current.id }, '[ports] Failed to renew SRT port reservation — keeping last known ports');
  }
}

/** One scheduler step: renew a held reservation, otherwise (re)try taking one. */
export async function tickPortReservation(log: FastifyBaseLogger): Promise<void> {
  if (inflightTick) return inflightTick;
  inflightTick = (async () => {
    switch (state.status) {
      case 'disabled':
        return;
      case 'reserved':
        await renew(log, state.reservation);
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

export function startPortReservation(log: FastifyBaseLogger): void {
  if (tickInterval !== null) return;
  if (state.status === 'disabled') {
    log.info('[ports] SRT port reservation disabled (STROM_PORT_LEASE_DISABLED)');
    return;
  }

  log.info(
    { ownerId: deriveOwnerId(config), count: config.stromPortLeaseSize, renewIntervalSec: TICK_INTERVAL_MS / 1000 },
    '[ports] SRT port reservation enabled',
  );

  void tickPortReservation(log);

  tickInterval = setInterval(() => {
    tickPortReservation(log).catch((err) => log.error({ err }, '[ports] Tick error'));
  }, TICK_INTERVAL_MS);

  // Allow the process to exit even if the interval is still running
  tickInterval.unref();
}

/** Stop renewing and release the reservation (best effort) — for graceful shutdown. */
export async function stopPortReservation(log: FastifyBaseLogger): Promise<void> {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (state.status !== 'reserved') return;
  const { reservation } = state;
  state = { status: 'pending' };
  try {
    const client = await clientFactory();
    await client.ports.reservations.release(reservation.id);
    log.info({ reservationId: reservation.id }, '[ports] Released SRT port reservation');
  } catch (err) {
    log.warn({ err, reservationId: reservation.id }, '[ports] Failed to release SRT port reservation — it will expire on its own');
  }
}

/**
 * Tell Strom which of our ports a flow uses, so they are not reclaimed under a
 * running pipeline even if this instance dies without releasing.
 *
 * Best effort: the reservation is what actually holds the ports, and an
 * association that never lands only costs the safety net. Failing a production
 * start over it would be worse than the problem.
 */
export async function assignPortsToFlow(
  log: PortLog,
  flowId: string,
  ports: number[],
): Promise<void> {
  if (state.status !== 'reserved' || ports.length === 0) return;
  const { reservation } = state;
  const mine = ports.filter((p) => reservation.ports.includes(p));
  if (mine.length === 0) return;
  try {
    const client = await clientFactory();
    await client.ports.reservations.assign(reservation.id, { flow_id: flowId, ports: mine });
    log.debug({ flowId, ports: mine }, '[ports] Declared listener ports in use by flow');
  } catch (err) {
    log.warn({ err, flowId, ports: mine }, '[ports] Could not declare listener ports in use — they are still reserved');
  }
}

/** Drop a flow's declaration. Best effort, for the same reason as assigning. */
export async function unassignPortsFromFlow(log: PortLog, flowId: string): Promise<void> {
  if (state.status !== 'reserved') return;
  const { reservation } = state;
  try {
    const client = await clientFactory();
    await client.ports.reservations.unassign(reservation.id, flowId);
    log.debug({ flowId }, '[ports] Dropped listener port declaration for flow');
  } catch {
    // A 404 is the normal case when the flow never had ports declared.
  }
}

// ---------------------------------------------------------------------------
// Test hooks
// ---------------------------------------------------------------------------

/** Replace the Strom client used by the service. Pass null to restore the default. */
export function _setStromClientFactory(factory: PortReservationClientFactory | null): void {
  clientFactory = factory ?? defaultClientFactory;
}

/** Reset module state between tests. */
export function _resetPortReservationState(initial: PortReservationState = { status: 'pending' }): void {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  state = initial;
  unsupportedSince = null;
  consecutiveAcquireFailures = 0;
  inflightTick = null;
}
