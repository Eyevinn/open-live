/**
 * In-memory per-production clip-state registry (epic #206, issues #277/#278).
 *
 * Mirrors `tally.service.ts`: live clip playback state is held only in memory
 * (never persisted on a doc for v1, per spec §"Data Model") and restored from
 * Strom's `player.getState` on connect. Indexed by `productionId` → `mixerInput`
 * → {@link ClipState}.
 *
 * Both the REST endpoints (#277) and the WS controller (#278) write here so a
 * newly-connected client can be sent the current `CLIP_STATE` for each clip
 * source in the connect-time sync sequence.
 */

import type { ClipState } from '../db/types.js';

const clipStateByProduction = new Map<string, Map<string, ClipState>>();

/** Returns the current clip state for a mixer input, or undefined if none tracked. */
export function getClipStateEntry(productionId: string, mixerInput: string): ClipState | undefined {
  return clipStateByProduction.get(productionId)?.get(mixerInput);
}

/** Returns all tracked clip states for a production (empty array if none). */
export function getAllClipStates(productionId: string): ClipState[] {
  const byInput = clipStateByProduction.get(productionId);
  return byInput ? Array.from(byInput.values()) : [];
}

/** Records/updates the clip state for a mixer input. */
export function setClipStateEntry(productionId: string, state: ClipState): void {
  let byInput = clipStateByProduction.get(productionId);
  if (!byInput) {
    byInput = new Map<string, ClipState>();
    clipStateByProduction.set(productionId, byInput);
  }
  byInput.set(state.mixerInput, state);
}

/** Clears all tracked clip state for a production (e.g. on deactivate). */
export function clearClipState(productionId: string): void {
  clipStateByProduction.delete(productionId);
}
