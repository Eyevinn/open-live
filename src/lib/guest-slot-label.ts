/**
 * Live multiview tile labelling for guest slots (issue #466).
 *
 * A guest slot's vision-mixer tile is labelled `Guest N` at flow-build time
 * (issues #458/#460, `flow-generator.ts`) because the invite name is only known
 * once the guest actually joins. Strom PR#1014 (strom#999) makes
 * `input_{N}_label` a LIVE property, settable with
 * `PATCH /api/flows/{flow_id}/blocks/{block_id}/properties`, so once a guest
 * joins we can push their invite name onto the tile with no flow restart, and
 * reset it to `Guest N` when they leave / the invite is revoked.
 *
 * Numbering MUST match the controller and the flow generator exactly: guest
 * slots (source assignments carrying a `returnFeed`) numbered by trailing pad
 * index DESCENDING, 1-indexed (the top of the mixer-input range is Guest 1 —
 * see `guestSlotNumber` in `flow-generator.ts` and open-live-studio#171). Do NOT
 * re-derive this from `returnBuses` order, which is ascending.
 *
 * The label is written to the COMPACT Strom pad the input is wired to
 * (`mixerInputMap`, issue #463), exactly as the flow generator writes the build
 * -time label — the overlay is indexed by the compact pad, not the stored one.
 *
 * Graceful degradation (issue #466 constraint): on a Strom older than PR#1014
 * the property is unknown and the PATCH is rejected. The caller's join/leave
 * must still succeed, so every failure here (rejected property, transport error)
 * is logged at `warn` and swallowed — this function never throws.
 */
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { getStromToken } from '../lib/strom-token.js';
import { StromClient } from './strom.js';
import { mixerInputToStromPad } from './mixer-input-map.js';
import type { ProductionDoc } from '../db/types.js';

/** Trailing pad index of a `video_in_N` mixer-input name (0 when absent). */
function trailingPadIndex(mixerInput: string): number {
  return parseInt(/(\d+)$/.exec(mixerInput)?.[1] ?? '0', 10);
}

/**
 * The `Guest N` number for a guest slot, or `null` when the mixer input is not a
 * declared guest slot on this production. Mirrors the flow generator's
 * `guestSlotNumber` map exactly: returnFeed assignments ordered by trailing pad
 * index DESCENDING, numbered 1..N.
 */
export function guestSlotNumber(
  production: ProductionDoc,
  mixerInput: string,
): number | null {
  const ordered = (production.sources ?? [])
    .filter((a) => !!a.returnFeed)
    .sort((a, b) => trailingPadIndex(b.mixerInput) - trailingPadIndex(a.mixerInput));
  const idx = ordered.findIndex((a) => a.mixerInput === mixerInput);
  return idx === -1 ? null : idx + 1;
}

/**
 * The default (guest-left / unlabelled) tile text for a guest slot: `Guest N`,
 * or `null` when the input is not a guest slot on this production (nothing to
 * reset).
 */
export function guestSlotDefaultLabel(
  production: ProductionDoc,
  mixerInput: string,
): string | null {
  const n = guestSlotNumber(production, mixerInput);
  return n === null ? null : `Guest ${n}`;
}

/**
 * Best-effort live update of a guest slot's multiview tile label on the vision
 * mixer. No-op (never throws) when:
 *   - the production has no live flow / mixer block (not activated — the label
 *     is then set at the next flow build);
 *   - the mixer input does not resolve to a Strom pad;
 *   - `label` is empty/null (nothing meaningful to show).
 *
 * On a Strom that rejects the (older-Strom-unknown) `input_{N}_label` live
 * property, or on any transport error, the failure is logged at `warn` and
 * swallowed so the caller's join/leave is never failed (issue #466).
 */
export async function applyGuestSlotMixerLabel(
  production: ProductionDoc,
  mixerInput: string,
  label: string | null | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const flowId = production.stromFlowId;
  const blockId = production.mixerBlockId;
  // Nothing live to label — the build-time label (flow-generator) covers the
  // not-yet-active case.
  if (!flowId || !blockId) return;

  const text = label?.trim();
  if (!text) return;

  const pad = mixerInputToStromPad(mixerInput, production.mixerInputMap);
  if (pad === null) return;

  const property = `input_${pad}_label`;
  try {
    const token = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token });
    await strom.flows.updateBlockProperties(flowId, blockId, {
      properties: { [property]: text },
    });
  } catch (err) {
    // Older Strom (pre strom#1014/PR#1014) does not know the live
    // `input_{N}_label` property and rejects it (StromPropertiesRejectedError),
    // or Strom is briefly unreachable. Either way the tile keeps its `Guest N`
    // build-time label — do NOT fail the guest join/leave over a cosmetic label.
    log.warn(
      { err, flowId, blockId, property, mixerInput },
      'guest slot label — Strom rejected the live input label; tile keeps its build-time label',
    );
  }
}
