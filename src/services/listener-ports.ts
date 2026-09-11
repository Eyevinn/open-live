/**
 * Port assignment inside this instance's leased block.
 *
 * The broker keeps Open Live instances apart; this keeps the sources and
 * outputs of one instance apart. Every hostless SRT listener address
 * (`srt://:PORT?mode=listener`) binds PORT on the shared Strom, so no two
 * documents may name the same one. A client that does not care which port it
 * gets sends `srt://:0?...` and is handed the lowest free port in the block,
 * which is how gateways register: several of them can then feed one instance
 * without knowing about each other.
 */

import { getOutputsDb, getSourcesDb } from '../db/index.js';
import type { PortLease } from '../lib/strom.js';
import { isPortInLease } from './port-lease.js';
import type { PortLeaseState } from './port-lease.js';

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

/** Every listener port a stored source or output binds. */
export async function usedListenerPorts(): Promise<ListenerPortUse[]> {
  const [sources, outputs] = await Promise.all([
    getSourcesDb().find({ selector: { type: 'source' } }),
    getOutputsDb().find({ selector: { type: 'output' } }),
  ]);
  const used: ListenerPortUse[] = [];
  for (const doc of Array.isArray(sources?.docs) ? sources.docs : []) {
    if (doc.streamType !== 'srt' && doc.streamType !== 'efp') continue;
    const port = listenerPortRequest(doc.address);
    if (port) used.push({ kind: 'source', id: doc._id, name: doc.name, port });
  }
  for (const doc of Array.isArray(outputs?.docs) ? outputs.docs : []) {
    if (!doc.url || (doc.outputType !== 'mpegtssrt' && doc.outputType !== 'efpsrt')) continue;
    const port = listenerPortRequest(doc.url);
    if (port) used.push({ kind: 'output', id: doc._id, name: doc.name, port });
  }
  return used;
}

export function lowestFreePort(lease: Pick<PortLease, 'first_port' | 'last_port'>, taken: Set<number>): number | null {
  for (let p = lease.first_port; p <= lease.last_port; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
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
 * Non-listener addresses pass through. A listener port must be inside the
 * leased block when there is one, and must not be bound by another document
 * either way. Port 0 asks for the lowest free port in the block; without a
 * block (no broker, or leasing disabled) there is nothing to choose from, and
 * while the lease is still pending the answer is "not yet".
 */
export function resolveListenerAddress(
  address: string,
  lease: PortLeaseState,
  used: ListenerPortUse[],
  opts: ResolveOptions = {},
): ListenerAddressResolution {
  const requested = listenerPortRequest(address);
  if (requested === null) return { ok: true, address, port: null };

  const others = used.filter((u) => !(opts.exclude && u.kind === opts.exclude.kind && u.id === opts.exclude.id));
  const taken = new Set(others.map((u) => u.port));
  const range = lease.status === 'leased' ? lease.lease : null;
  const rangeText = range ? `${range.first_port}-${range.last_port}` : '';

  if (requested === ASSIGN_PORT) {
    if (lease.status === 'pending') {
      return { ok: false, statusCode: 503, error: 'SRT port range not yet allocated from Strom, retry shortly' };
    }
    if (!range) {
      return { ok: false, statusCode: 400, error: 'No SRT port range to assign from on this instance; give the listener address an explicit port' };
    }
    if (opts.keep && isPortInLease(opts.keep, range) && !taken.has(opts.keep)) {
      return { ok: true, address: withListenerPort(address, opts.keep), port: opts.keep };
    }
    const port = lowestFreePort(range, taken);
    if (port === null) {
      return { ok: false, statusCode: 409, error: `No free SRT listener port left in this instance's range ${rangeText}` };
    }
    return { ok: true, address: withListenerPort(address, port), port };
  }

  if (lease.status === 'pending') {
    return { ok: false, statusCode: 503, error: 'SRT port range not yet allocated from Strom, retry shortly' };
  }
  if (range && !isPortInLease(requested, range)) {
    return { ok: false, statusCode: 422, error: `SRT listener port ${requested} is outside this instance's allocated range ${rangeText}` };
  }
  const holder = others.find((u) => u.port === requested);
  if (holder) {
    return { ok: false, statusCode: 409, error: `SRT listener port ${requested} is already used by ${holder.kind} "${holder.name}"` };
  }
  return { ok: true, address, port: requested };
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
