/**
 * Writing a source or output whose SRT address holds something on the shared
 * Strom: a listener port (`srt://:PORT`) or a relay id (`srt+relay://<id>`).
 *
 * Resolve (fill in `:0` / `auto`, refuse what another document holds), write,
 * then look again: two concurrent writers can both pass the first check, so a
 * clash found after the write undoes it, and is retried when the server chose
 * the port or id, or refused with 409 when the client named it. Shared by the
 * create and update handlers of sources and outputs.
 */

import type { FastifyBaseLogger } from 'fastify';
import { isSrtRelayAddress } from '../lib/srt-relay.js';
import { getPortReservation } from './port-reservation.js';
import { getSrtRelayStatus } from './srt-relay-status.js';
import { resolveSrtAddress, srtClashAfterWrite, usedSrtBindings } from './listener-ports.js';

export type SrtWriteResult<T> = { ok: true; value: T } | { ok: false; statusCode: number; error: string };

export interface SrtWriteOptions<T> {
  /** The requested address, plaintext (`srt://:0`, `srt+relay://auto`, …). */
  address: string;
  /** The document being written. */
  self: { kind: 'source' | 'output'; id: string };
  /** The address the document holds today (stored form), for `auto` / `:0` to keep. */
  keepFrom?: string | null;
  /**
   * Persist the document with the resolved address. Returns what the handler
   * replies with and how to undo the write if it turns out to clash.
   */
  write: (address: string) => Promise<{ value: T; undo: () => Promise<void> }>;
  log: FastifyBaseLogger;
}

const MAX_RETRIES = 3;

export async function writeWithSrtAddress<T>(opts: SrtWriteOptions<T>): Promise<SrtWriteResult<T>> {
  // Only relay addresses need Strom's relay status (served from cache).
  const relay = isSrtRelayAddress(opts.address) ? await getSrtRelayStatus() : undefined;
  for (let attempt = 0; ; attempt++) {
    const resolved = resolveSrtAddress(opts.address, getPortReservation(), await usedSrtBindings(), {
      self: opts.self,
      keepFrom: opts.keepFrom,
      relay,
    });
    if (!resolved.ok) return resolved;
    const { value, undo } = await opts.write(resolved.address);
    if (resolved.port === null && resolved.relayId === null) return { ok: true, value };
    const clash = srtClashAfterWrite(await usedSrtBindings(), opts.self, resolved);
    if (!clash) return { ok: true, value };
    await undo();
    if (!resolved.assigned || attempt >= MAX_RETRIES) return { ok: false, statusCode: 409, error: clash };
    opts.log.warn({ self: opts.self, clash }, 'SRT listener port or relay id was taken while assigning it, choosing another');
  }
}
