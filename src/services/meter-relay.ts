import { StromClient } from '../lib/strom.js';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { broadcast } from './tally.service.js';
import { guestHealthMessage, guestHealthSnapshot } from './guest-health.js';

interface RelayEntry {
  stop: () => void;
  refCount: number;
  /** Identifies this relay instance; a force-stop and restart gets a new one. */
  generation: number;
  flowId: string;
  meterPrefix: string;
  loudnessBlockId?: string | null;
  /** Guest input block id → guest seat, for relaying `BlockHealthChanged`. */
  guestBlocks: ReadonlyMap<string, string>;
}

const relays = new Map<string, RelayEntry>();
// Last flow each production's deactivate tore down. Flow ids are never reused,
// so an entry only goes stale, never wrong; the next deactivate overwrites it.
const retiredFlows = new Map<string, string>();
const RECONNECT_DELAY_MS = 5000;
let nextGeneration = 1;

/**
 * Take one ref on the production's meter relay, creating it if needed. Returns
 * the relay's generation; pass it to `stopMeterRelay` to release that ref.
 */
export function startMeterRelay(productionId: string, flowId: string, mixerBlockId: string, loudnessBlockId?: string | null, guestBlocks: ReadonlyMap<string, string> = new Map()): number {
  const meterPrefix = `${mixerBlockId}:meter:`;
  const existing = relays.get(productionId);
  if (existing) {
    existing.refCount++;
    // A connect that read the doc mid-deactivate can start the relay on the
    // torn-down flow. Move it to the next flow seen, but never off a live one:
    // a start that is late with the old flow only takes a ref.
    if (existing.flowId !== flowId && existing.flowId === retiredFlows.get(productionId)) {
      existing.flowId = flowId;
      existing.meterPrefix = meterPrefix;
      existing.loudnessBlockId = loudnessBlockId;
    }
    if (existing.flowId === flowId) existing.guestBlocks = guestBlocks;
    return existing.generation;
  }

  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Guest blocks that had a live health event since the current re-read
  // started; the re-read's older view must not overwrite them.
  let healthSeen: Set<string> | null = null;

  // Health events sent while this socket was down are lost, so on every open
  // re-read the flow's current block_health and broadcast each guest seat.
  function rereadGuestHealth(strom: StromClient) {
    if (entry.guestBlocks.size === 0) return;
    const readFlowId = entry.flowId;
    const seen = new Set<string>();
    healthSeen = seen;
    strom.flows.get(readFlowId).then(({ flow }) => {
      if (stopped || entry.flowId !== readFlowId || healthSeen !== seen) return;
      healthSeen = null;
      for (const message of guestHealthSnapshot(entry.guestBlocks, flow.block_health)) {
        if (!seen.has(message.blockId)) broadcast(productionId, message);
      }
    }).catch((err: unknown) => {
      console.warn('[meter-relay] guest health re-read failed:', err);
    });
  }

  function connect() {
    if (stopped) return;

    void getStromToken(config.stromToken).then((token) => {
      if (stopped) return;

      const strom = new StromClient({ baseUrl: config.stromUrl, token });

      const closeCleanup = strom.connectWebSocket(
        (event) => {
          if (event.type === 'LoudnessData' && entry.loudnessBlockId) {
            const { flow_id, element_id, momentary, shortterm, integrated, loudness_range, true_peak } = event.data;
            if (flow_id !== entry.flowId || element_id !== entry.loudnessBlockId) return;
            broadcast(productionId, { type: 'LOUDNESS_DATA', elementId: 'main', momentary, shortterm, integrated, loudness_range, true_peak });
            return;
          }
          if (event.type === 'BlockHealthChanged') {
            if (event.data.flow_id !== entry.flowId) return;
            healthSeen?.add(event.data.block_id);
            const message = guestHealthMessage(entry.guestBlocks, event.data);
            if (message) broadcast(productionId, message);
            return;
          }
          if (event.type !== 'MeterData') return;
          const { flow_id, element_id, rms, peak } = event.data;
          if (flow_id !== entry.flowId) return;
          if (!element_id.startsWith(entry.meterPrefix)) return;
          const suffix = element_id.slice(entry.meterPrefix.length);
          if (suffix === 'main') {
            broadcast(productionId, { type: 'METER_DATA', elementId: 'main', peak, rms });
            return;
          }
          if (suffix === 'monitor') {
            broadcast(productionId, { type: 'METER_DATA', elementId: 'monitor', peak, rms });
            return;
          }
          // AUX bus master meters: Strom emits "meter:aux1", "meter:aux2" (1-indexed)
          if (suffix.startsWith('aux')) {
            const auxNum = parseInt(suffix.slice(3), 10);
            if (Number.isFinite(auxNum)) {
              broadcast(productionId, { type: 'METER_DATA', elementId: `aux${auxNum}`, peak, rms });
              return;
            }
          }
          // GROUP bus master meters: Strom emits "meter:group1", "meter:group2" (1-indexed)
          if (suffix.startsWith('group')) {
            const grpNum = parseInt(suffix.slice(5), 10);
            if (Number.isFinite(grpNum)) {
              broadcast(productionId, { type: 'METER_DATA', elementId: `grp${grpNum}`, peak, rms });
              return;
            }
          }
          const chNum = parseInt(suffix, 10);
          if (!Number.isFinite(chNum)) return;
          broadcast(productionId, { type: 'METER_DATA', elementId: `ch${chNum}`, peak, rms });
        },
        () => {
          if (!stopped) {
            reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
          }
        },
        () => rereadGuestHealth(strom),
      );

      wsCleanup = closeCleanup;
    }).catch((err: unknown) => {
      if (!stopped) {
        console.warn(`[meter-relay] Token fetch failed, retrying in ${RECONNECT_DELAY_MS}ms:`, err);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      }
    });
  }

  const entry: RelayEntry = {
    refCount: 1,
    generation: nextGeneration++,
    flowId,
    meterPrefix,
    loudnessBlockId,
    guestBlocks,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsCleanup?.();
    },
  };

  connect();
  relays.set(productionId, entry);
  return entry.generation;
}

/**
 * Reconcile the relay onto `flowId` with exactly `holderCount` refs — used by
 * reactivation reinit (issue #434). Deactivate's `forceStopMeterRelay` zeroes
 * the refCount but leaves each controller's per-socket hold intact, and a
 * connect mid-teardown may have re-created the relay on the now-retired flow.
 * Per-socket `startMeterRelay` calls there would either miss re-creating a
 * force-stopped relay (losing meters for an operator that stayed open) or
 * double-count the mid-teardown socket (an orphaned ref that never reaches
 * zero). Since every controller socket, watch-only included, backs exactly one
 * ref (connect takes one, close releases one), this rebinds any existing relay
 * onto the new flow and sets its refCount to the socket count so the later
 * per-socket stops land it back on zero. Returns the relay's generation, or
 * undefined (a no-op) when `holderCount <= 0`.
 */
export function reconcileMeterRelay(productionId: string, flowId: string, mixerBlockId: string, loudnessBlockId: string | null | undefined, holderCount: number, guestBlocks: ReadonlyMap<string, string> = new Map()): number | undefined {
  if (holderCount <= 0) return undefined;
  const meterPrefix = `${mixerBlockId}:meter:`;
  const existing = relays.get(productionId);
  if (existing) {
    // The production has exactly one flow at a time; any existing relay is on
    // the retired flow (mid-teardown connect) or already on this flow. Either
    // way rebinding onto `flowId` is correct here.
    existing.flowId = flowId;
    existing.meterPrefix = meterPrefix;
    existing.loudnessBlockId = loudnessBlockId;
    existing.guestBlocks = guestBlocks;
    existing.refCount = holderCount;
    return existing.generation;
  }
  const generation = startMeterRelay(productionId, flowId, mixerBlockId, loudnessBlockId, guestBlocks);
  const created = relays.get(productionId);
  if (created) created.refCount = holderCount;
  return generation;
}

/** Current ref count for a production's meter relay (0 when none). Diagnostic. */
export function getMeterRelayRefCount(productionId: string): number {
  return relays.get(productionId)?.refCount ?? 0;
}

/**
 * Release one ref. With `generation`, release only if the relay is still that
 * instance: a ref taken on a relay that was since force-stopped is already gone,
 * and releasing it would take a ref another socket owns.
 */
export function stopMeterRelay(productionId: string, generation?: number): void {
  const entry = relays.get(productionId);
  if (!entry) return;
  if (generation !== undefined && entry.generation !== generation) return;
  entry.refCount--;
  if (entry.refCount <= 0) {
    entry.stop();
    relays.delete(productionId);
  }
}

/**
 * Force-stop and forget the relay regardless of refCount (deactivate/teardown),
 * and record `flowId` as torn down so a relay started on it later is rebound.
 * Mirrors `forceStopClipRelay` (#416).
 */
export function forceStopMeterRelay(productionId: string, flowId?: string): void {
  if (flowId) retiredFlows.set(productionId, flowId);
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.stop();
  relays.delete(productionId);
}
