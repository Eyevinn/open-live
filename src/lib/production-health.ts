/**
 * Production lifecycle + output health derivation (issue #255).
 *
 * Pure, dependency-free helpers so the transition rule and the output-health
 * derivation can be unit-tested in isolation and reused across the REST routes,
 * the idle-watchdog, the startup reconcile, and the WS `PRODUCTION_STATUS`
 * event. See `docs/specs/production-lifecycle-health.md`.
 *
 * Honesty note (spec §2 / OQ-2): Strom exposes only a coarse *flow-level*
 * `running` / `FlowState` signal, not a per-output/per-block liveness signal.
 * We therefore derive only `healthy | down | unknown` from that flow-level
 * signal. The `degraded` value is part of the enum shape (future-proofed for a
 * later per-output signal) but is NEVER emitted here — do not populate it until
 * Strom exposes a per-output health source (OQ-2).
 */

import type { ProductionStatus, OutputStatus } from '../db/types.js';

/**
 * The status a production moves to when its (currently running) flow stops —
 * whether by explicit deactivate, idle-watchdog auto-deactivate, or reconcile
 * discovering its Strom flow disappeared.
 *
 * Transition rule (spec §1, stated precisely):
 *  - A production that was `active` (i.e. reached a live broadcast) and then
 *    stops transitions to `ended`.
 *  - A production that never reached `active` (still `activating`, or a
 *    failed/aborted activation) transitions to `inactive` — it never broadcast,
 *    so there is nothing to "end".
 *
 * `inactive` keeps meaning "clean idle / never-ran-this-cycle"; `ended` means
 * "ran a broadcast and that broadcast has finished". `ended` is not terminal:
 * re-activating moves back through `activating` → `active` as before.
 */
export function stoppedStatus(currentStatus: ProductionStatus): 'ended' | 'inactive' {
  return currentStatus === 'active' ? 'ended' : 'inactive';
}

/**
 * Derive an output's health from the coarse flow-level signal available today.
 *
 * @param opts.stromKnown  Whether the Strom flow state could be observed at all.
 *   When Strom is unreachable — or for legacy docs where nothing can be
 *   determined — the honest answer is `unknown`, not `down`.
 * @param opts.productionActive  Whether the owning production is `active`.
 * @param opts.flowRunning  Whether the owning production's Strom flow is running
 *   (`Flow.running === true`, equivalently `FlowState === 'playing'`).
 *
 * Derivation (spec §2):
 *  - `healthy` — production `active` AND its flow running (uniformly across all
 *    outputs of a running, playing flow).
 *  - `down`    — production not active, or flow not running (but Strom state is
 *    known).
 *  - `unknown` — Strom state could not be determined.
 *
 * `degraded` is intentionally never returned (see file header / OQ-2).
 */
export function deriveOutputStatus(opts: {
  stromKnown: boolean;
  productionActive: boolean;
  flowRunning: boolean;
}): OutputStatus {
  if (!opts.stromKnown) return 'unknown';
  return opts.productionActive && opts.flowRunning ? 'healthy' : 'down';
}

/** Per-output health entry carried in a `PRODUCTION_STATUS` snapshot. */
export interface OutputStatusEntry {
  id: string;
  status: OutputStatus;
}

/**
 * The `PRODUCTION_STATUS` WS lifecycle event (spec §3).
 *
 * Reuses #209's broadcast envelope: `ts` is stamped centrally in `broadcast()`
 * (see `src/services/tally.service.ts`), so it is intentionally NOT set here. A
 * per-production monotonic `seq` is added together with the #209 envelope
 * rollout once that lands (it has not yet); until then the event carries `ts`
 * only, exactly as the spec's §3 note prescribes.
 */
export interface ProductionStatusEvent {
  type: 'PRODUCTION_STATUS';
  productionId: string;
  status: ProductionStatus;
  outputs: OutputStatusEntry[];
}

/** Build a `PRODUCTION_STATUS` event payload (without the `ts` envelope stamp). */
export function buildProductionStatusEvent(
  productionId: string,
  status: ProductionStatus,
  outputs: OutputStatusEntry[],
): ProductionStatusEvent {
  return { type: 'PRODUCTION_STATUS', productionId, status, outputs };
}

/**
 * Derive the per-output health snapshot for a single production.
 *
 * Because the only signal available is flow-level, every output assigned to the
 * production shares the same derived status (spec §2: "all outputs of a running,
 * playing flow, uniformly").
 */
export function deriveOutputSnapshot(opts: {
  outputIds: string[];
  stromKnown: boolean;
  productionActive: boolean;
  flowRunning: boolean;
}): OutputStatusEntry[] {
  const status = deriveOutputStatus({
    stromKnown: opts.stromKnown,
    productionActive: opts.productionActive,
    flowRunning: opts.flowRunning,
  });
  return opts.outputIds.map((id) => ({ id, status }));
}
