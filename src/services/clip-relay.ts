/**
 * Reactive clip-state relay (epic #206, issue #307 / OQ2).
 *
 * Subscribes to Strom's flow WebSocket and translates the media_player block's
 * pushed `MediaPlayerStateChanged` / `MediaPlayerPosition` events into
 * `CLIP_STATE` broadcasts, keyed back to the owning `mixerInput`. This is the
 * PRIMARY completion/position mechanism — `player.getState` polling in
 * `ws/controller.ts` is retained only as a reconciliation fallback.
 *
 * Mirrors `meter-relay.ts`: one WS connection per production, ref-counted across
 * controller connections, auto-reconnecting on close. Started at controller
 * connect (once a running flow with clip player blocks is known) and stopped on
 * the last controller disconnect / deactivate.
 *
 * State reported here is authoritative for the live `playing`/`paused`/`stopped`
 * edges and playhead position. `cued`/`completed`/`error` are decided by the
 * controller (Strom has no `cued`/`completed` notion), so the relay never
 * downgrades a locally-tracked `cued`/`completed`/`error` clip to a raw Strom
 * state — it only reports transitions Strom actually pushes.
 */

import { StromClient } from '../lib/strom.js';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { broadcast } from './tally.service.js';
import { getClipStateEntry, setClipStateEntry } from './clip-state.service.js';
import { clearPersistedClipCue } from './clip-cue-store.js';
import type { ClipState } from '../db/types.js';

interface RelayEntry {
  stop: () => void;
  refCount: number;
  /** blockId → mixerInput for this production's clip sources. */
  blockToInput: Map<string, string>;
  flowId: string;
}

const relays = new Map<string, RelayEntry>();
const RECONNECT_DELAY_MS = 5000;

/**
 * Records a Strom-reported player transition for a clip and broadcasts the
 * resulting CLIP_STATE — unless the controller is holding a state Strom cannot
 * observe (cued/completed/error), in which case a raw `stopped` is not allowed
 * to clobber it (a cued clip reports `stopped`/`paused` to Strom).
 */
export function applyReactiveState(
  productionId: string,
  mixerInput: string,
  stromState: 'playing' | 'paused' | 'stopped',
  positionMs?: number,
  durationMs?: number,
): void {
  const tracked = getClipStateEntry(productionId, mixerInput);

  // A cued clip sits paused/stopped in Strom; a completed clip is stopped. Never
  // let a raw Strom `stopped`/`paused` downgrade those controller-owned states.
  if (tracked) {
    if ((tracked.state === 'cued' || tracked.state === 'completed') && stromState !== 'playing') {
      return;
    }
    if (tracked.state === 'error' && stromState !== 'playing') {
      return;
    }
  }

  // Map Strom's end-of-media (`stopped` while we believed the clip was playing)
  // to the controller's `completed` edge, matching the poll-fallback semantics.
  let mapped: ClipState['state'];
  if (stromState === 'playing') mapped = 'playing';
  else if (stromState === 'paused') mapped = 'paused';
  else mapped = tracked?.state === 'playing' ? 'completed' : 'stopped';

  const next: ClipState = {
    mixerInput,
    state: mapped,
    ...(tracked?.clipId !== undefined ? { clipId: tracked.clipId } : {}),
    ...(positionMs !== undefined ? { positionMs } : {}),
    ...(durationMs !== undefined ? { durationMs } : tracked?.durationMs !== undefined ? { durationMs: tracked.durationMs } : {}),
  };
  setClipStateEntry(productionId, next);
  broadcast(productionId, { type: 'CLIP_STATE', ...next });
  // A completed clip is no longer cued — drop the persisted cue point so it is
  // not restored to `cued` after a restart (issue #307 / OQ3).
  if (mapped === 'completed') {
    void clearPersistedClipCue(productionId, mixerInput);
  }
}

/**
 * Emits a position-only CLIP_STATE update for a playing clip. Ignored unless the
 * clip is currently `playing` locally (a position tick on a paused/cued clip is
 * not a meaningful transition to broadcast).
 */
export function applyReactivePosition(
  productionId: string,
  mixerInput: string,
  positionMs: number,
  durationMs?: number,
): void {
  const tracked = getClipStateEntry(productionId, mixerInput);
  if (!tracked || tracked.state !== 'playing') return;
  const next: ClipState = {
    ...tracked,
    positionMs,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  setClipStateEntry(productionId, next);
  broadcast(productionId, { type: 'CLIP_STATE', ...next });
}

/**
 * Start (or ref-count into) the reactive clip relay for a production.
 * `blockToInput` maps each clip media-player blockId to its mixerInput, derived
 * from `ProductionDoc.clipPlayerBlockIds`.
 */
export function startClipRelay(productionId: string, flowId: string, blockToInput: Map<string, string>): void {
  const existing = relays.get(productionId);
  if (existing) {
    existing.refCount++;
    // Refresh the mapping/flow in case the flow was rebuilt while connected.
    existing.blockToInput = blockToInput;
    return;
  }
  if (blockToInput.size === 0) return;

  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const entry: RelayEntry = {
    refCount: 1,
    blockToInput,
    flowId,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsCleanup?.();
    },
  };

  function connect() {
    if (stopped) return;
    void getStromToken(config.stromToken).then((token) => {
      if (stopped) return;
      const strom = new StromClient({ baseUrl: config.stromUrl, token });
      wsCleanup = strom.connectWebSocket(
        (event) => {
          if (event.type === 'MediaPlayerStateChanged') {
            const { flow_id, block_id, state, position_ms, duration_ms } = event.data;
            if (flow_id !== entry.flowId) return;
            const mixerInput = entry.blockToInput.get(block_id);
            if (!mixerInput) return;
            applyReactiveState(productionId, mixerInput, state, position_ms, duration_ms);
            return;
          }
          if (event.type === 'MediaPlayerPosition') {
            const { flow_id, block_id, position_ms, duration_ms } = event.data;
            if (flow_id !== entry.flowId) return;
            const mixerInput = entry.blockToInput.get(block_id);
            if (!mixerInput) return;
            applyReactivePosition(productionId, mixerInput, position_ms, duration_ms);
            return;
          }
        },
        () => {
          if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        },
      );
    }).catch((err: unknown) => {
      if (!stopped) {
        console.warn(`[clip-relay] token fetch failed, retrying in ${RECONNECT_DELAY_MS}ms:`, err);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });
  }

  connect();
  relays.set(productionId, entry);
}

/** Ref-counted stop; tears down the WS on the last controller disconnect. */
export function stopClipRelay(productionId: string): void {
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.stop();
    relays.delete(productionId);
  }
}

/** Force-stop and forget the relay regardless of refCount (deactivate/teardown). */
export function forceStopClipRelay(productionId: string): void {
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.stop();
  relays.delete(productionId);
}
