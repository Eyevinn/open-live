/**
 * Port assignment inside the set this instance reserved from Strom.
 *
 * The reservation keeps Open Live instances apart; this keeps the sources and
 * outputs of one instance apart. Every hostless SRT listener address
 * (`srt://:PORT?mode=listener`) binds PORT on the shared Strom, so no two
 * documents may name the same one. A client that does not care which port it
 * gets sends `srt://:0?...` and is handed the lowest free port this instance
 * holds, which is how gateways register: several of them can then feed one
 * instance without knowing about each other.
 *
 * Strom's set is not necessarily contiguous, so everything here works on
 * membership rather than on a first/last range.
 *
 * Relay ids (`srt+relay://<id>`) are bookkept here too: they are the other
 * thing an SRT source or output holds on the shared Strom, in one namespace
 * across sources and outputs. `usedSrtBindings()` scans for both at once and
 * `resolveSrtAddress()` is the one resolver for either kind of address.
 */

import { getOutputsDb, getSourcesDb } from '../db/index.js';
import { isPortReserved } from './port-reservation.js';
import { parseSrtRelayAddress, resolveSrtRelayAddress, SRT_RELAY_AUTO_ID } from '../lib/srt-relay.js';
import type { PortReservationState } from './port-reservation.js';
import type { SrtRelayStatus } from './srt-relay-status.js';

/** The value of PORT in `srt://:PORT` that asks the server to choose. */
export const ASSIGN_PORT = 0;

/** A port some stored document already binds. */
export interface ListenerPortUse {
  kind: 'source' | 'output';
  id: string;
  name: string;
  port: number;
}

/**
 * The port of a hostless SRT listener address, `0` when the client asks the
 * server to choose, or null for anything that binds nothing here: caller form
 * with a host, other schemes, or an explicit non-listener mode. A hostless
 * address without a `mode` is a listener, since hostless can only bind.
 */
export function listenerPortRequest(address: string): number | null {
  const m = /^srt:\/\/:(\d{1,5})(?:\?([^#]*))?$/i.exec(address.trim());
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port > 65535) return null;
  const mode = new URLSearchParams(m[2] ?? '').get('mode');
  if (mode !== null && mode.toLowerCase() !== 'listener') return null;
  return port;
}

/** The same address with its port replaced. */
export function withListenerPort(address: string, port: number): string {
  return address.trim().replace(/^srt:\/\/:\d{1,5}/i, `srt://:${port}`);
}

/** A relay id some stored document already holds. */
export interface RelayIdUse {
  kind: 'source' | 'output';
  id: string;
  name: string;
  relayId: string;
}

/**
 * What the stored sources and outputs hold on the shared Strom: listener ports
 * (`srt://:PORT`) and relay ids (`srt+relay://<id>`). A relay id is the
 * streamid both callers use on the SRT relay, which pairs exactly two callers
 * per streamid, so sources and outputs share one namespace for ids as they do
 * for ports.
 */
export interface SrtBindings {
  ports: ListenerPortUse[];
  relayIds: RelayIdUse[];
}

/** One scan of every stored source and output for the ports and relay ids they hold. */
export async function usedSrtBindings(): Promise<SrtBindings> {
  const [sources, outputs] = await Promise.all([
    getSourcesDb().find({ selector: { type: 'source' } }),
    getOutputsDb().find({ selector: { type: 'output' } }),
  ]);
  const bindings: SrtBindings = { ports: [], relayIds: [] };
  const add = (kind: 'source' | 'output', id: string, name: string, address: string) => {
    const relayId = parseSrtRelayAddress(address)?.id;
    if (relayId) {
      bindings.relayIds.push({ kind, id, name, relayId });
      return;
    }
    const port = listenerPortRequest(address);
    if (port) bindings.ports.push({ kind, id, name, port });
  };
  for (const doc of Array.isArray(sources?.docs) ? sources.docs : []) {
    if ((doc.streamType === 'srt' || doc.streamType === 'efp') && doc.address) add('source', doc._id, doc.name, doc.address);
  }
  for (const doc of Array.isArray(outputs?.docs) ? outputs.docs : []) {
    if (doc.url && (doc.outputType === 'mpegtssrt' || doc.outputType === 'efpsrt')) add('output', doc._id, doc.name, doc.url);
  }
  return bindings;
}

/** The lowest reserved port no document holds, or null when every one is taken. */
export function lowestFreePort(reserved: readonly number[], taken: Set<number>): number | null {
  for (const p of [...reserved].sort((a, b) => a - b)) {
    if (!taken.has(p)) return p;
  }
  return null;
}

/** How a set of ports reads in an error message: runs where it can, ports where it cannot. */
export function describePorts(ports: readonly number[]): string {
  const sorted = [...ports].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] + 1 === p) last[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

export type ListenerAddressResolution =
  | { ok: true; address: string; port: number | null }
  | { ok: false; statusCode: 400 | 409 | 422 | 503; error: string };

export interface ResolveOptions {
  /** The document being edited, so its own current port does not count as taken. */
  exclude?: { kind: 'source' | 'output'; id: string };
  /**
   * The port the document holds today. An assignment request keeps it when it
   * is still valid, so a client that re-registers gets the same port back.
   */
  keep?: number | null;
}

/**
 * Decide the address a source or output may be stored with.
 *
 * Non-listener addresses pass through. A listener port must be one this
 * instance reserved when it holds any, and must not be bound by another
 * document either way. Port 0 asks for the lowest free reserved port; without
 * a reservation (Strom hands out no ports, or reservation is disabled here)
 * there is nothing to choose from, and while one is still pending the answer
 * is "not yet".
 */
export function resolveListenerAddress(
  address: string,
  reservation: PortReservationState,
  used: ListenerPortUse[],
  opts: ResolveOptions = {},
): ListenerAddressResolution {
  const requested = listenerPortRequest(address);
  if (requested === null) return { ok: true, address, port: null };

  const others = used.filter((u) => !(opts.exclude && u.kind === opts.exclude.kind && u.id === opts.exclude.id));
  const taken = new Set(others.map((u) => u.port));
  const reserved = reservation.status === 'reserved' ? reservation.reservation.ports : null;
  const portsText = reserved ? describePorts(reserved) : '';

  if (requested === ASSIGN_PORT) {
    if (reservation.status === 'pending') {
      return { ok: false, statusCode: 503, error: 'SRT listener ports not yet reserved from Strom, retry shortly' };
    }
    if (!reserved) {
      return { ok: false, statusCode: 400, error: 'No reserved SRT ports to assign from on this instance; give the listener address an explicit port' };
    }
    if (opts.keep && isPortReserved(opts.keep, reserved) && !taken.has(opts.keep)) {
      return { ok: true, address: withListenerPort(address, opts.keep), port: opts.keep };
    }
    const port = lowestFreePort(reserved, taken);
    if (port === null) {
      return { ok: false, statusCode: 409, error: `No free SRT listener port left in this instance's reserved set ${portsText}` };
    }
    return { ok: true, address: withListenerPort(address, port), port };
  }

  if (reservation.status === 'pending') {
    return { ok: false, statusCode: 503, error: 'SRT listener ports not yet reserved from Strom, retry shortly' };
  }
  if (reserved && !isPortReserved(requested, reserved)) {
    return { ok: false, statusCode: 422, error: `SRT listener port ${requested} is not reserved by this instance; it holds ${portsText}` };
  }
  const holder = others.find((u) => u.port === requested);
  if (holder) {
    return { ok: false, statusCode: 409, error: `SRT listener port ${requested} is already used by ${holder.kind} "${holder.name}"` };
  }
  return { ok: true, address, port: requested };
}

type DocRef = { kind: 'source' | 'output'; id: string };

const isSelf = (u: { kind: string; id: string }, self?: DocRef) => !!self && u.kind === self.kind && u.id === self.id;

/** The 409 text for a relay id another document holds. */
export function relayIdClashMessage(holder: RelayIdUse): string {
  return `SRT relay id is already used by ${holder.kind} "${holder.name}"; every source and output needs its own relay id`;
}

/** The 409 text for a listener port another document holds. */
export function listenerPortClashMessage(holder: ListenerPortUse): string {
  return `SRT listener port ${holder.port} is already used by ${holder.kind} "${holder.name}"`;
}

export type SrtAddressResolution =
  | {
      ok: true;
      /** The address to store (plaintext): port or relay id filled in. */
      address: string;
      /** The listener port it binds, or null. */
      port: number | null;
      /** The relay id it holds, or null. */
      relayId: string | null;
      /** True when the server chose the port or id (`srt://:0`, `srt+relay://auto`), so a clash may be retried. */
      assigned: boolean;
    }
  | { ok: false; statusCode: 400 | 409 | 422 | 503; error: string };

export interface SrtResolveOptions {
  /** The document being written; what it holds itself does not count as taken. */
  self?: DocRef;
  /**
   * The address the document holds today (stored form). `srt+relay://auto`
   * keeps its relay id, `srt://:0` keeps its listener port when still valid,
   * so a re-submitted request never changes what the outside party dials.
   */
  keepFrom?: string | null;
  /** Strom's relay status; a definite "no relay" refuses relay addresses. */
  relay?: Pick<SrtRelayStatus, 'configured' | 'state'>;
}

/**
 * Decide the address an SRT source or output may be stored with: the one
 * resolver for listener ports and relay ids alike.
 *
 * - A relay address (`srt+relay://<id>`) binds no port. `auto` gets a
 *   generated id (or keeps the stored one); the id must not be held by any
 *   other source or output (409). When Strom positively reports that it has no
 *   relay the address is refused (422); when Strom cannot be asked it is
 *   accepted, and the dial-in address says why it is unknown.
 * - Anything else goes through `resolveListenerAddress`.
 */
export function resolveSrtAddress(
  address: string,
  reservation: PortReservationState,
  used: SrtBindings,
  opts: SrtResolveOptions = {},
): SrtAddressResolution {
  const relay = parseSrtRelayAddress(address);
  if (relay) {
    if (opts.relay && opts.relay.state === 'ok' && !opts.relay.configured) {
      return {
        ok: false,
        statusCode: 422,
        error: 'Strom reports no SRT relay configured, so srt+relay:// addresses cannot be used; use an srt:// listener or caller address',
      };
    }
    const resolved = resolveSrtRelayAddress(address, opts.keepFrom);
    const relayId = parseSrtRelayAddress(resolved)!.id;
    const holder = used.relayIds.find((u) => u.relayId === relayId && !isSelf(u, opts.self));
    if (holder) return { ok: false, statusCode: 409, error: relayIdClashMessage(holder) };
    return { ok: true, address: resolved, port: null, relayId, assigned: relay.id === SRT_RELAY_AUTO_ID };
  }
  const keep = opts.keepFrom ? listenerPortRequest(opts.keepFrom) : null;
  const resolved = resolveListenerAddress(address, reservation, used.ports, { exclude: opts.self, keep });
  if (!resolved.ok) return resolved;
  return { ...resolved, relayId: null, assigned: listenerPortRequest(address) === ASSIGN_PORT };
}

/**
 * Two writers can both pass `resolveSrtAddress` with the same port or relay id,
 * because the read and the write are separate CouchDB calls. After writing,
 * look again: the 409 text when another document now holds what this one was
 * given, so the caller undoes its write (and retries when the server chose).
 */
export function srtClashAfterWrite(
  used: SrtBindings,
  self: DocRef,
  held: { port: number | null; relayId: string | null },
): string | undefined {
  if (held.relayId !== null) {
    const holder = used.relayIds.find((u) => u.relayId === held.relayId && !isSelf(u, self));
    if (holder) return relayIdClashMessage(holder);
  }
  if (held.port !== null) {
    const holder = clashesAfterWrite(used.ports, self, held.port);
    if (holder) return listenerPortClashMessage(holder);
  }
  return undefined;
}

/**
 * Two clients asking for a port at the same moment can both be handed the
 * lowest free one, because the read and the write are separate CouchDB calls.
 * After writing, look again: if another document now holds our assigned port
 * and is older than ours, the caller should undo and retry. The chance is
 * small (gateways register at start-up, one input at a time); the check keeps
 * it from becoming a silent double booking.
 */
export function clashesAfterWrite(used: ListenerPortUse[], mine: { kind: 'source' | 'output'; id: string }, port: number): ListenerPortUse | undefined {
  return used.find((u) => u.port === port && !(u.kind === mine.kind && u.id === mine.id));
}
