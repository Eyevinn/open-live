/**
 * Stored ↔ compact vision-mixer pad translation (issue #463).
 *
 * Studio allocates guest slots from the top of the mixer-input range down
 * (video_in_15, video_in_14, …), so the flow generator sizes the live Strom
 * vision mixer to exactly what the production uses and compacts the sparse stored
 * pads to a contiguous 0..N-1 range, persisting the mapping on the production doc
 * as `mixerInputMap` (stored `mixerInput` → compact Strom pad index).
 *
 * The STORED `mixerInput` stays the stable external identity — invites, return
 * feeds, the Studio controller and every WS/REST message key off it. These
 * helpers are applied ONLY at the Strom boundary: forward (stored → compact) when
 * writing a pad index into a Strom transition / PiP / effect call, and inverse
 * (compact → stored) when re-expanding a Strom state read-back (input_resolutions,
 * input_effects) so the client still indexes by the stored pad.
 *
 * Every function is identity / pass-through when `mixerInputMap` is absent (older
 * active flows persisted before this change, or a production with no compaction),
 * so the common contiguous-from-0 case is byte-for-byte unchanged.
 */

/** Parse the numeric pad index from a `video_in_N` mixer-input name. */
export function storedPadIndex(mixerInput: string): number | null {
  const m = /video_in_(\d+)$/.exec(mixerInput);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The 1-indexed stored Studio slot number displayed for a mixer input
 * (ADR-007). Studio shows mixer-input pads 1-indexed, so stored `video_in_5` is
 * "Input 6". This is the operator-facing slot number the guest was placed in —
 * independent of the #463-compacted Strom pad the tile physically renders at.
 * Returns `null` when the input is not a `video_in_N` pad.
 */
export function guestSlotStudioInputNumber(mixerInput: string): number | null {
  const stored = storedPadIndex(mixerInput);
  return stored === null ? null : stored + 1;
}

/**
 * Append the stored Studio slot number to a guest-tile overlay label
 * (ADR-007 Option C — guest tiles only), e.g. `Guest 1` → `Guest 1 · In 6`,
 * `Ada` → `Ada · In 6`. The physical pad badge keeps the #463-compacted number;
 * this suffix carries the operator's Studio slot number into the overlay text so
 * the label matches the slot the operator set, without touching the compaction.
 * Returns `label` unchanged when the input is not a `video_in_N` pad.
 */
export function withGuestSlotStudioInputSuffix(label: string, mixerInput: string): string {
  const n = guestSlotStudioInputNumber(mixerInput);
  return n === null ? label : `${label} · In ${n}`;
}

/**
 * Forward: the compact Strom pad index for a stored `mixerInput` name. Falls back
 * to the stored numeric index when the input is not in the map.
 */
export function mixerInputToStromPad(
  mixerInput: string,
  map: Record<string, number> | undefined,
): number | null {
  const mapped = map?.[mixerInput];
  if (typeof mapped === 'number') return mapped;
  return storedPadIndex(mixerInput);
}

/**
 * Forward: the compact Strom pad index for a stored numeric pad index (as carried
 * by PiP `bg` / zone `sources` / effect `target.input`). Identity when the input
 * is not compacted.
 */
export function storedPadToStromPad(
  storedIndex: number,
  map: Record<string, number> | undefined,
): number {
  const mapped = map?.[`video_in_${storedIndex}`];
  return typeof mapped === 'number' ? mapped : storedIndex;
}

/**
 * Inverse: re-expand a Strom state array indexed by compact pad back to a dense
 * array indexed by the stored pad, so the client keeps indexing by stored pad.
 * Holes (pads with no assignment) become `null`. Pass-through when no map.
 */
export function expandToStoredPadIndex<T>(
  compact: readonly T[],
  map: Record<string, number> | undefined,
): Array<T | null> {
  if (!map) return [...compact];
  const out: Array<T | null> = [];
  for (const [mixerInput, compactIdx] of Object.entries(map)) {
    const stored = storedPadIndex(mixerInput);
    if (stored === null) continue;
    out[stored] = compactIdx < compact.length ? compact[compactIdx]! : null;
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] === undefined) out[i] = null;
  }
  return out;
}
