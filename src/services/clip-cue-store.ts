/**
 * Persistence for clip cue points (epic #206, issue #307 / OQ3).
 *
 * A cued clip must survive deactivate/reactivate AND server restart — restored to
 * `cued` at the cue point, never auto-playing — mirroring the persistence rule
 * for PiP layout (`ProductionDoc.pipConfigs`) and tally. The cue point lives on
 * `ProductionDoc.clipCues` (a `mixerInput → PersistedClipCue` map); this module is
 * the single read-merge-write coupling point so both the WS controller and the
 * reactive clip-relay can persist/clear cues without a circular import.
 *
 * All writes are 409-safe (via updateProductionDoc) and best-effort: a persist
 * failure is logged, not thrown, because the live cue/transition already
 * succeeded and must not be undone by a doc-write hiccup.
 */

import { getDb } from '../db/index.js';
import { updateProductionDoc } from '../routes/productions.js';
import type { PersistedClipCue } from '../db/types.js';

/** Persist (read-merge-write) a single mixerInput's cue point. */
export async function persistClipCue(productionId: string, mixerInput: string, cue: PersistedClipCue): Promise<void> {
  try {
    const doc = await getDb().get(productionId);
    const clipCues = { ...(doc.clipCues ?? {}), [mixerInput]: cue };
    await updateProductionDoc(productionId, { clipCues });
  } catch (err) {
    console.warn(`[clip-cue-store] persist cue error (${mixerInput}):`, String(err));
  }
}

/** Remove a single mixerInput's persisted cue point (on stop/completion). */
export async function clearPersistedClipCue(productionId: string, mixerInput: string): Promise<void> {
  try {
    const doc = await getDb().get(productionId);
    if (!doc.clipCues || !(mixerInput in doc.clipCues)) return;
    const clipCues = { ...doc.clipCues };
    delete clipCues[mixerInput];
    await updateProductionDoc(productionId, { clipCues });
  } catch (err) {
    console.warn(`[clip-cue-store] clear cue error (${mixerInput}):`, String(err));
  }
}
