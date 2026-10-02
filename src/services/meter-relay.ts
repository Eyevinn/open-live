import { StromClient } from '../lib/strom.js';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { broadcast } from './tally.service.js';

interface RelayEntry {
  stop: () => void;
  refCount: number;
  flowId: string;
  meterPrefix: string;
  loudnessBlockId?: string | null;
}

const relays = new Map<string, RelayEntry>();
// Last flow each production's deactivate tore down. Flow ids are never reused,
// so an entry only goes stale, never wrong; the next deactivate overwrites it.
const retiredFlows = new Map<string, string>();
const RECONNECT_DELAY_MS = 5000;

export function startMeterRelay(productionId: string, flowId: string, mixerBlockId: string, loudnessBlockId?: string | null): void {
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
    return;
  }

  let stopped = false;
  let wsCleanup: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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
    flowId,
    meterPrefix,
    loudnessBlockId,
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsCleanup?.();
    },
  };

  connect();
  relays.set(productionId, entry);
}

export function stopMeterRelay(productionId: string): void {
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
 * Mirrors `forceStopClipRelay` (#416).
 */
export function forceStopMeterRelay(productionId: string, flowId?: string): void {
  if (flowId) retiredFlows.set(productionId, flowId);
  const entry = relays.get(productionId);
  if (!entry) return;
  entry.stop();
  relays.delete(productionId);
}
