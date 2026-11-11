/**
 * Relay-id uniqueness across this instance's sources and outputs.
 *
 * A relay id is the streamid both callers use on the SRT relay, and the relay
 * pairs exactly two callers per streamid. Two documents with the same id would
 * pair Strom with itself (a source and an output) or be refused by the relay
 * (two of a kind), so sources and outputs share one namespace and an id may be
 * held by one document only. Mirrors the listener-port bookkeeping in
 * listener-ports.ts: check before the write, and re-check after it because two
 * concurrent writes can both pass the first check.
 */

import { getOutputsDb, getSourcesDb } from '../db/index.js';
import { parseSrtRelayAddress } from '../lib/srt-relay.js';

/** A relay id some stored document already holds. */
export interface RelayIdUse {
  kind: 'source' | 'output';
  id: string;
  name: string;
  relayId: string;
}

/** Every relay id a stored source or output holds. */
export async function usedRelayIds(): Promise<RelayIdUse[]> {
  const [sources, outputs] = await Promise.all([
    getSourcesDb().find({ selector: { type: 'source' } }),
    getOutputsDb().find({ selector: { type: 'output' } }),
  ]);
  const used: RelayIdUse[] = [];
  for (const doc of Array.isArray(sources?.docs) ? sources.docs : []) {
    if (doc.streamType !== 'srt' && doc.streamType !== 'efp') continue;
    const relayId = parseSrtRelayAddress(doc.address ?? '')?.id;
    if (relayId) used.push({ kind: 'source', id: doc._id, name: doc.name, relayId });
  }
  for (const doc of Array.isArray(outputs?.docs) ? outputs.docs : []) {
    if (!doc.url || (doc.outputType !== 'mpegtssrt' && doc.outputType !== 'efpsrt')) continue;
    const relayId = parseSrtRelayAddress(doc.url)?.id;
    if (relayId) used.push({ kind: 'output', id: doc._id, name: doc.name, relayId });
  }
  return used;
}

/** The other document holding `relayId`, if any (`self` is the document being written). */
export function relayIdHolder(
  used: RelayIdUse[],
  relayId: string,
  self?: { kind: 'source' | 'output'; id: string },
): RelayIdUse | undefined {
  return used.find((u) => u.relayId === relayId && !(self && u.kind === self.kind && u.id === self.id));
}

/** The 409 text for a relay id another document holds. */
export function relayIdClashMessage(holder: RelayIdUse): string {
  return `SRT relay id is already used by ${holder.kind} "${holder.name}"; every source and output needs its own relay id`;
}
