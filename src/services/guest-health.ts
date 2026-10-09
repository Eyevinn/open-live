/**
 * Guest-seat health from Strom's block health scan.
 *
 * Strom reports a block whose element chain has stopped passing data while the
 * pipeline stays PLAYING: `BlockHealthChanged` on /api/ws on each change, and
 * the current `block_health` list on GET /api/flows/:id. This maps a
 * production's guest input blocks to their guest seats and turns those reports
 * into `GUEST_HEALTH` controller messages. The meter relay feeds it live events
 * (it already holds the production's Strom WS); the controller connect snapshot
 * feeds it the flow's `block_health`, so a reconnecting studio sees a failure
 * that is still going on.
 */

import type { ProductionDoc } from '../db/types.js';
import type { BlockHealthReport } from '../lib/strom.js';

/** A guest seat's health, as sent to controllers. */
export interface GuestHealthMessage {
  type: 'GUEST_HEALTH';
  /** The guest seat (the slot's mixer input, e.g. `video_in_15`). */
  mixerInput: string;
  blockId: string;
  status: 'ok' | 'failed';
  /** Strom's human-readable detail; absent when the block is healthy. */
  detail?: string;
  /**
   * Strom's structured causes, passed through unchanged when Strom sends them
   * (e.g. `{ kind: 'whip_medium', slot, medium, fault }`). Open Live does not
   * interpret them.
   */
  causes?: unknown[];
}

/**
 * Guest input block id → guest seat for a production. A guest seat is a source
 * assignment carrying a `returnFeed`; its input block is built by the flow
 * generator as `b-input-<padIndex>-<endpointSuffix>`.
 */
export function guestInputBlocks(doc: Pick<ProductionDoc, '_id' | 'sources'>): Map<string, string> {
  const endpointSuffix = doc._id.replace(/^prod-/, '').slice(0, 8);
  const blocks = new Map<string, string>();
  for (const assignment of doc.sources ?? []) {
    if (!assignment.returnFeed) continue;
    const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
    if (!padMatch) continue;
    blocks.set(`b-input-${padMatch[1]}-${endpointSuffix}`, assignment.mixerInput);
  }
  return blocks;
}

/**
 * Builds the `GUEST_HEALTH` message for one Strom health report, or `null` when
 * the block is not one of this production's guest inputs or the status is
 * neither `ok` nor `failed` (a status from a newer Strom must not clear a
 * failure).
 */
export function guestHealthMessage(
  guestBlocks: ReadonlyMap<string, string>,
  report: BlockHealthReport,
): GuestHealthMessage | null {
  const mixerInput = guestBlocks.get(report.block_id);
  if (!mixerInput) return null;
  const status = report.status;
  if (status !== 'ok' && status !== 'failed') return null;
  const causes = report.causes;
  return {
    type: 'GUEST_HEALTH',
    mixerInput,
    blockId: report.block_id,
    status,
    ...(status === 'failed' && typeof report.detail === 'string' ? { detail: report.detail } : {}),
    ...(status === 'failed' && Array.isArray(causes) && causes.length > 0 ? { causes } : {}),
  };
}

/**
 * One `GUEST_HEALTH` per guest seat from a flow's current `block_health` list.
 * A seat Strom does not list is reported `ok`: Strom lists only blocks it has
 * scanned, and clears the list when the pipeline stops, so an absent entry
 * means no known failure. Sending every seat lets a reconnecting studio drop a
 * failure that ended while it was away. A malformed `block_health` (not an
 * array, or entries that are not objects) is skipped rather than thrown on,
 * since callers send this alongside the meter and audio init.
 */
export function guestHealthSnapshot(
  guestBlocks: ReadonlyMap<string, string>,
  blockHealth: unknown,
): GuestHealthMessage[] {
  const byBlock = new Map<string, BlockHealthReport>();
  for (const h of Array.isArray(blockHealth) ? blockHealth : []) {
    if (h !== null && typeof h === 'object' && typeof h.block_id === 'string') byBlock.set(h.block_id, h);
  }
  const messages: GuestHealthMessage[] = [];
  for (const blockId of guestBlocks.keys()) {
    const report = byBlock.get(blockId) ?? { block_id: blockId, status: 'ok' as const };
    const message = guestHealthMessage(guestBlocks, report);
    if (message) messages.push(message);
  }
  return messages;
}
