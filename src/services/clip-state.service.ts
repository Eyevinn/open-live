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
  // Drop any pending play flags for this production's inputs too.
  for (const key of [...playPendingByKey.keys()]) {
    if (key.startsWith(`${productionId}:`)) clearClipPlayPendingByKey(key);
  }
}

// ---------------------------------------------------------------------------
// Play-pending flags (issue #350).
//
// Strom's `goto` (issued during Cue) briefly drives the media-player pipeline to
// `playing` before `cueClip`'s `stop()` parks it, producing a `playing` push
// while the clip is still tracked as `cued`. The reactive relay suppresses that
// edge unless Open Live has itself just sent Play. `playClip` sets a short-lived
// play-pending flag so the relay can tell a genuine Play from the goto artefact.
// The flag auto-expires so a Play whose `playing` push never arrives cannot
// strand it and wrongly whitelist a later cue's goto edge.
// ---------------------------------------------------------------------------
const playPendingByKey = new Map<string, ReturnType<typeof setTimeout>>();
const PLAY_PENDING_TTL_MS = 5000;

function playPendingKey(productionId: string, mixerInput: string): string {
  return `${productionId}:${mixerInput}`;
}

function clearClipPlayPendingByKey(key: string): void {
  const timer = playPendingByKey.get(key);
  if (timer) {
    clearTimeout(timer);
    playPendingByKey.delete(key);
  }
}

/** Marks that Open Live has just sent Play for this clip (short-lived). */
export function markClipPlayPending(productionId: string, mixerInput: string): void {
  const key = playPendingKey(productionId, mixerInput);
  clearClipPlayPendingByKey(key);
  const timer = setTimeout(() => { playPendingByKey.delete(key); }, PLAY_PENDING_TTL_MS);
  // Do not keep the event loop (or a test run) alive on the expiry timer.
  timer.unref?.();
  playPendingByKey.set(key, timer);
}

/** True while a Play sent by Open Live is still awaiting its Strom `playing` push. */
export function isClipPlayPending(productionId: string, mixerInput: string): boolean {
  return playPendingByKey.has(playPendingKey(productionId, mixerInput));
}

/** Clears the play-pending flag for a clip (called once the push is consumed). */
export function clearClipPlayPending(productionId: string, mixerInput: string): void {
  clearClipPlayPendingByKey(playPendingKey(productionId, mixerInput));
}
