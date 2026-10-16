/**
 * Live vision-mixer control for guest slots (issues #466, #493).
 *
 * A guest slot's vision-mixer tile is labelled `Guest N` at flow-build time
 * (issues #458/#460, `flow-generator.ts`) because the invite name is only known
 * once the guest actually joins. Strom PR#1014 (strom#999) makes
 * `input_{N}_label` a LIVE property, settable with
 * `PATCH /api/flows/{flow_id}/blocks/{block_id}/properties`, so once a guest
 * joins we can push their invite name onto the tile with no flow restart, and
 * reset it to `Guest N` when they leave / the invite is revoked.
 *
 * The same live-property channel also drives the slot's PICTURE (issue #493).
 * When a guest's WHIP publisher drops on leave/kick/revoke, the whip_input block
 * keeps its last decoded frame, so the vision mixer carries on compositing the
 * guest's frozen last frame onto PGM and the multiview. The vision mixer exposes
 * a live per-input alpha (`input_{N}_alpha`, 0.0–1.0 — strom-block-config.md), so
 * at teardown we push that input's alpha to 0 (black the slot) and restore it to
 * 1 when a new guest takes the slot. Same best-effort contract as the label: a
 * Strom that does not know the property rejects it and the slot simply keeps its
 * frame — the leave/kick/revoke/join is never failed.
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
import { mixerInputToStromPad, withGuestSlotStudioInputSuffix } from './mixer-input-map.js';
import { loadAudioChannels } from './audio-channels.js';
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
 * Shared best-effort PATCH of one of a guest slot's live vision-mixer input
 * properties (label, alpha, …). Resolves the live flow/mixer block and the
 * COMPACT Strom pad (issue #463) for the stored `mixerInput`, lets `build`
 * produce the `properties` map keyed by that pad, and writes it. Never throws:
 *   - no-op when the production has no live flow / mixer block (not activated —
 *     the build-time flow generator covers that case);
 *   - no-op when the mixer input does not resolve to a Strom pad;
 *   - no-op when `build` returns null (nothing meaningful to write);
 *   - any rejected property (older Strom unaware of the live property) or
 *     transport error is logged at `warn` with `logMessage` and swallowed so the
 *     caller's join/leave/kick/revoke is never failed.
 */
async function patchGuestSlotMixerInput(
  production: ProductionDoc,
  mixerInput: string,
  build: (pad: number) => Record<string, unknown> | null,
  log: FastifyBaseLogger,
  logMessage: string,
): Promise<void> {
  const flowId = production.stromFlowId;
  const blockId = production.mixerBlockId;
  if (!flowId || !blockId) return;

  const pad = mixerInputToStromPad(mixerInput, production.mixerInputMap);
  if (pad === null) return;

  const properties = build(pad);
  if (!properties) return;

  try {
    const token = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token });
    await strom.flows.updateBlockProperties(flowId, blockId, { properties });
  } catch (err) {
    log.warn({ err, flowId, blockId, properties, mixerInput }, logMessage);
  }
}

/**
 * Best-effort live update of a guest slot's multiview tile label on the vision
 * mixer. No-op (never throws) when the production has no live flow / mixer block,
 * the mixer input does not resolve to a Strom pad, or `label` is empty/null.
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
  const text = label?.trim();
  await patchGuestSlotMixerInput(
    production,
    mixerInput,
    // ADR-007 Option C (guest tiles only): the live multiview tile carries the
    // operator's stored Studio slot number alongside the invite / `Guest N` name
    // (e.g. "Ada · In 6"), matching the build-time label in flow-generator.ts.
    // The audio strip (applyGuestSlotAudioStripLabel) keeps the plain name.
    (pad) =>
      text ? { [`input_${pad}_label`]: withGuestSlotStudioInputSuffix(text, mixerInput) } : null,
    log,
    // Older Strom (pre strom#1014/PR#1014) does not know the live
    // `input_{N}_label` property and rejects it (StromPropertiesRejectedError),
    // or Strom is briefly unreachable. Either way the tile keeps its `Guest N`
    // build-time label — do NOT fail the guest join/leave over a cosmetic label.
    'guest slot label — Strom rejected the live input label; tile keeps its build-time label',
  );
}

/**
 * Best-effort live update of a guest slot's AUDIO mixer strip label — the
 * `ch{N}_label` property on the audio `builtin.mixer` block (issues #464, #494).
 *
 * The flow generator writes the audio strip the SAME `Guest N` text as the
 * multiview tile at build time, so the picture and the audio desk agree. The
 * tile label is a live property (#466) and is reset to `Guest N` on
 * leave/kick/revoke, but the audio strip was left untouched, so after a guest
 * left the strip kept the departed guest's name and no longer matched the tile
 * (issue #494). This resets (or updates) the strip to the supplied text so the
 * two stay in sync.
 *
 * Addressing differs from the video tile: the audio channel is numbered by the
 * audio mixer's own ordering (`loadAudioChannels`, ascending by pad — issue
 * #487), NOT the compact video pad, and the property lives on
 * `audioMixerBlockId`, not the video mixer block. Never throws, under the same
 * contract as `applyGuestSlotMixerLabel`:
 *   - no-op when the production has no live flow / audio mixer block;
 *   - no-op when `label` is empty/null, or the mixer input does not resolve to
 *     an audio channel on this production;
 *   - any rejected property (older Strom unaware of the live `ch{N}_label`
 *     property), transport error, or sources-DB lookup failure is logged at
 *     `warn` and swallowed so the caller's join/leave/kick/revoke is never
 *     failed.
 */
export async function applyGuestSlotAudioStripLabel(
  production: ProductionDoc,
  mixerInput: string,
  label: string | null | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  const text = label?.trim();
  if (!text) return;

  const flowId = production.stromFlowId;
  const audioBlockId = production.audioMixerBlockId;
  if (!flowId || !audioBlockId) return;

  try {
    // The audio strip index comes from the audio mixer's own channel ordering
    // (ascending by pad), which differs from the guest tile number — resolve it
    // from the SAME source-assignment ordering the flow generator wired.
    const channels = await loadAudioChannels(production.sources ?? []);
    const match = channels.find((c) => c.assignment.mixerInput === mixerInput);
    if (match === undefined) return;

    const token = await getStromToken(config.stromToken);
    const strom = new StromClient({ baseUrl: config.stromUrl, token });
    await strom.flows.updateBlockProperties(flowId, audioBlockId, {
      properties: { [`ch${match.channel + 1}_label`]: text },
    });
  } catch (err) {
    log.warn(
      { err, flowId, audioBlockId, mixerInput },
      // Older Strom does not know the live `ch{N}_label` property and rejects it
      // (StromPropertiesRejectedError), Strom is briefly unreachable, or the
      // sources DB is down — either way the strip keeps its current name. Do NOT
      // fail the guest join/leave over a cosmetic audio-strip label.
      'guest slot audio strip label — Strom rejected the live channel label (or channel lookup failed); the strip keeps its current name',
    );
  }
}

/**
 * Best-effort black-out of a released guest slot's picture (issue #493). A WHIP
 * publisher that drops leaves the whip_input block holding its last decoded
 * frame, which the vision mixer keeps compositing onto PGM and the multiview, so
 * on leave/kick/revoke we set the slot input's live alpha to 0 — the frozen frame
 * goes black instead of staying on air. No-op / never throws under the same
 * conditions as the label write; a Strom that does not know `input_{N}_alpha`
 * rejects it and the slot simply keeps its frame — the teardown is never failed.
 */
export async function clearGuestSlotPicture(
  production: ProductionDoc,
  mixerInput: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await patchGuestSlotMixerInput(
    production,
    mixerInput,
    (pad) => ({ [`input_${pad}_alpha`]: 0 }),
    log,
    'guest slot picture — Strom rejected the live input alpha; the slot may keep its last frame',
  );
}

/**
 * Best-effort restore of a guest slot's picture to fully opaque (issue #493) when
 * a new guest takes the slot. `clearGuestSlotPicture` leaves the slot input's
 * alpha at 0 after the previous guest left, so without this a rejoining / next
 * guest on the same live flow would be invisible. No-op / never throws under the
 * same conditions as the label write.
 */
export async function restoreGuestSlotPicture(
  production: ProductionDoc,
  mixerInput: string,
  log: FastifyBaseLogger,
): Promise<void> {
  await patchGuestSlotMixerInput(
    production,
    mixerInput,
    (pad) => ({ [`input_${pad}_alpha`]: 1 }),
    log,
    'guest slot picture — Strom rejected the live input alpha; the slot may start black',
  );
}
