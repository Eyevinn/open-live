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
import { getClipStateEntry, setClipStateEntry, isClipPlayPending, clearClipPlayPending } from './clip-state.service.js';
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
// Last flow each production's deactivate tore down (see meter-relay.ts).
const retiredFlows = new Map<string, string>();
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
    // A clip in `error` (a preflight/stall failure, or a dead decode branch
    // surfaced from a Strom PipelineError — issue #360) is never downgraded to a
    // raw Strom state, including `playing`: a media_player block can keep
    // reporting `playing` after its branch has died, and that must never read
    // back as PLAYING in Studio. Recovery requires an explicit re-cue.
    if (tracked.state === 'error') {
      return;
    }
    // A `cued` clip transiently reports `playing` in Strom because Cue's `goto`
    // starts the pipeline before `cueClip`'s `stop()` parks it (issue #350).
    // Suppress that edge unless Open Live has itself just sent Play — in which
    // case the `playing` is real; consume the play-pending flag so a later cue's
    // goto artefact is not mistaken for it.
    if (tracked.state === 'cued' && stromState === 'playing') {
      if (!isClipPlayPending(productionId, mixerInput)) return;
      clearClipPlayPending(productionId, mixerInput);
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
 * Records an authoritative playback failure for a clip and broadcasts a
 * `CLIP_STATE` error (issue #360). Unlike a raw Strom state edge, a pipeline
 * error overrides whatever the clip was tracked as — a dead decode branch is
 * fatal regardless of the media_player's own reported state — and the `error`
 * guard in `applyReactiveState` then keeps a later raw `playing` push from
 * clobbering it. Pre-existing clipId/position/duration are preserved for context.
 */
export function applyReactiveError(
  productionId: string,
  mixerInput: string,
  error?: string,
): void {
  const tracked = getClipStateEntry(productionId, mixerInput);
  const next: ClipState = {
    mixerInput,
    state: 'error',
    ...(tracked?.clipId !== undefined ? { clipId: tracked.clipId } : {}),
    ...(tracked?.positionMs !== undefined ? { positionMs: tracked.positionMs } : {}),
    ...(tracked?.durationMs !== undefined ? { durationMs: tracked.durationMs } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  setClipStateEntry(productionId, next);
  broadcast(productionId, { type: 'CLIP_STATE', ...next });
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
    // Move a relay off a torn-down flow, never off a live one (see
    // startMeterRelay). The block map belongs to the flow, so it moves with it.
    if (existing.flowId !== flowId && existing.flowId === retiredFlows.get(productionId)) {
      existing.flowId = flowId;
    }
    if (existing.flowId === flowId) existing.blockToInput = blockToInput;
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
            // Strom's MediaPlayerStateChanged carries no position/duration — it
            // is a pure state edge; playhead comes via MediaPlayerPosition.
            const { flow_id, block_id, state } = event.data;
            if (flow_id !== entry.flowId) return;
            const mixerInput = entry.blockToInput.get(block_id);
            if (!mixerInput) return;
            applyReactiveState(productionId, mixerInput, state);
            return;
          }
          if (event.type === 'MediaPlayerPosition') {
            // Strom reports position/duration in NANOSECONDS (position_ns /
            // duration_ns); the CLIP_STATE contract is in milliseconds.
            const { flow_id, block_id, position_ns, duration_ns } = event.data;
            if (flow_id !== entry.flowId) return;
            const mixerInput = entry.blockToInput.get(block_id);
            if (!mixerInput) return;
            const positionMs = Math.round(position_ns / 1e6);
            const durationMs = duration_ns !== undefined ? Math.round(duration_ns / 1e6) : undefined;
            applyReactivePosition(productionId, mixerInput, positionMs, durationMs);
            return;
          }
          if (event.type === 'PipelineError') {
            // A failing pipeline element (e.g. an appsink/appsrc negotiation
            // failure on a clip's decode branch) means no picture reaches the
            // mixer even while the media_player block may still report
            // `playing`. Match the failing `source` back to a clip player block
            // and surface CLIP_STATE error so the dead branch is visible to the
            // operator instead of reading PLAYING forever (issue #360).
            const { flow_id, source, error } = event.data;
            if (flow_id !== undefined && flow_id !== entry.flowId) return;
            if (typeof source !== 'string') return;
            for (const [blockId, mixerInput] of entry.blockToInput) {
              // Strom qualifies the element by pad (`<blockId>:appsrc_video`,
              // `<blockId>:queue_video`, …) or reports the block id itself.
              if (source === blockId || source.startsWith(`${blockId}:`)) {
                applyReactiveError(productionId, mixerInput, error);
                break;
              }
            }
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

/**
 * Force-stop and forget the relay regardless of refCount (deactivate/teardown),
 * and record `flowId` as torn down so a relay started on it later is rebound.
 */
export function forceStopClipRelay(productionId: string, flowId?: string): void {
  if (flowId) retiredFlows.set(productionId, flowId);
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.stop();
  relays.delete(productionId);
}
