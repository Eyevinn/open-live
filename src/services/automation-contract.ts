/**
 * Automation-control contract helpers (issue #209, spec §3).
 *
 * Provides:
 *  - Contribution-based tally computation — replaces the single-slot
 *    { pgm, pvw } model with computed contribution sets that correctly
 *    cover PiP, DSK, and graphics-overlay states.
 *  - CONTRACT_VERSION constant published in HELLO events.
 *
 * All exports are pure functions / constants — no side effects, no I/O.
 * The controller imports them and calls them when building TALLY broadcasts
 * and the connect-time snapshot.
 */

import type { PipConfig } from '../lib/strom.js';

/** Semver contract version sent in HELLO on every WS connect. */
export const CONTRACT_VERSION = '1.0.0';

/**
 * The role a source plays in the mix at a given moment.
 *  - main    : the primary PGM or PVW real-source input
 *  - pip-bg  : the real input that appears as PiP background behind a PiP slot
 *  - pip-inset: a source appearing inside a PiP zone (defined by the PiP layout)
 *  - dsk     : a keyer layer that has been toggled on — the keyer source feeds video
 *  - graphic : an active graphics overlay
 */
export type ContributionRole = 'main' | 'pip-bg' | 'pip-inset' | 'dsk' | 'graphic';

export interface Contribution {
  source: string;
  role: ContributionRole;
}

export interface TallyContributions {
  /** All mixer-input pads contributing to program output (legacy: tally.pgm first element if any) */
  program: string[];
  /** All mixer-input pads contributing to preview output */
  preview: string[];
  /** Richer breakdown with per-source roles */
  contributions: Contribution[];
}

/**
 * Mixer-input pad→source mapping entry.
 * The controller already tracks `mixerInput` (e.g. 'video_in_2') as the
 * production-internal pad name. Contribution tally surfaces these directly
 * because that is what the controller already tracks; vendor adapters map
 * pad names to their own source identifiers.
 */

/**
 * Computes the contribution-based tally for a production from the controller's
 * current in-memory state.
 *
 * Parameters mirror the existing in-memory registries in controller.ts.
 *
 * @param pgm           - current PGM mixer input (null if a PiP is on PGM)
 * @param pvw           - current PVW mixer input (null if a PiP is on PVW)
 * @param pgmPip        - PiP slot index on PGM, or null
 * @param pvwPip        - PiP slot index on PVW, or null
 * @param pgmBg         - the real input behind a PiP that is on PGM, or null
 * @param pvwBefore     - the real input that was on PVW before a PiP was selected, or null
 * @param pipConfigs    - per-slot PiP layout (bg + zones); may be empty/undefined
 * @param dskLayers     - map of layer→visible for DSK keyers
 * @param activeGraphics- list of active (non-null) graphic overlay IDs
 */
export function computeTallyContributions(
  pgm: string | null,
  pvw: string | null,
  pgmPip: number | null,
  pvwPip: number | null,
  pgmBg: string | null,
  pvwBefore: string | null,
  pipConfigs: PipConfig[] | undefined,
  dskLayers: Record<number, boolean> | undefined,
  activeGraphics: string[],
): TallyContributions {
  const programSet = new Set<string>();
  const previewSet = new Set<string>();
  const contributions: Contribution[] = [];

  // ---- Program contributions ----

  if (pgmPip !== null) {
    // A PiP slot is on program. The real background input (pgmBg) is what is
    // actually visible as the program background, and any PiP-inset sources
    // from that slot's zone config also contribute.
    if (pgmBg) {
      programSet.add(pgmBg);
      contributions.push({ source: pgmBg, role: 'pip-bg' });
    }
    // PiP zone insets: each zone's source list contributes to program.
    const cfg = pipConfigs?.[pgmPip];
    if (cfg) {
      addPipZoneSources(cfg, programSet, contributions, 'pip-inset');
    }
  } else if (pgm) {
    // Normal main-source on program.
    programSet.add(pgm);
    contributions.push({ source: pgm, role: 'main' });
  }

  // DSK layers contribute to program when visible (keyer composites over PGM).
  if (dskLayers) {
    for (const [layerStr, visible] of Object.entries(dskLayers)) {
      if (visible) {
        // DSK layers are identified by their pad index. We surface the layer
        // number as a symbolic string 'dsk:<N>' — the adapter maps to its source.
        const source = `dsk:${layerStr}`;
        programSet.add(source);
        contributions.push({ source, role: 'dsk' });
      }
    }
  }

  // Active graphics overlays contribute to program output.
  for (const overlayId of activeGraphics) {
    const source = `gfx:${overlayId}`;
    programSet.add(source);
    contributions.push({ source, role: 'graphic' });
  }

  // ---- Preview contributions ----

  if (pvwPip !== null) {
    // A PiP slot is on preview.
    if (pvwBefore) {
      previewSet.add(pvwBefore);
    }
    const cfg = pipConfigs?.[pvwPip];
    if (cfg) {
      addPipZoneSources(cfg, previewSet, null, 'pip-inset');
    }
  } else if (pvw) {
    previewSet.add(pvw);
  }

  return {
    program: Array.from(programSet),
    preview: Array.from(previewSet),
    contributions,
  };
}

/**
 * Helper: iterate the zone sources of a PiP slot config and add each non-null
 * source index as a mixer-input pad name ('video_in_<N>') to the target set.
 *
 * @param cfg          - the PiP slot config
 * @param targetSet    - the set to add source pad names to
 * @param contribs     - contributions array to append to (null = skip)
 * @param role         - the role to assign to each source
 */
function addPipZoneSources(
  cfg: PipConfig,
  targetSet: Set<string>,
  contribs: Contribution[] | null,
  role: ContributionRole,
): void {
  if (!cfg.zones || cfg.zones.length === 0) return;
  for (const zone of cfg.zones) {
    for (const sourceIdx of zone.sources ?? []) {
      const pad = `video_in_${sourceIdx}`;
      targetSet.add(pad);
      contribs?.push({ source: pad, role });
    }
  }
}
