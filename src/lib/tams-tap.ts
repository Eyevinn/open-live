/**
 * TAMS tap: every input of a production is also written to a TAMS store, from
 * inside the production's own Strom flow (no separate ingest flows).
 *
 * Per tapped input the flow generator adds, next to the input's `time_offset`
 * blocks, a leaky queue, a Reference Timestamp and an H.264 encode on the video
 * and a leaky queue and an AAC encode on the audio, feeding one
 * `builtin.tams_output`. The TAMS Output
 * block refuses raw audio as well as raw video, so both are encoded here. The tap is taken before the
 * lipsync offset, like the ISO input recorder, so the store holds the feed as
 * it arrived. A recording may drop frames, the program must not: the queues are
 * leaky so a slow TAMS gateway never back-pressures the mixers.
 *
 * The tap is off unless `TAMS_GATEWAY_URL` is set. No credential goes into the
 * flow: the gateway token comes from Strom's own environment
 * (`STROM_TAMS_API_TOKEN`, or the OSC PAT with `TAMS_AUTH_MODE=osc`).
 */
import { createHash } from 'crypto';
import type { ActivationWarning, ProductionSourceAssignment, SourceDoc } from '../db/types.js';

/** Strom block that writes pre-encoded media to a TAMS gateway. */
export const TAMS_OUTPUT_BLOCK = 'builtin.tams_output';
/** Strom block the tap encodes video with: the TAMS block refuses raw video. */
export const TAMS_VIDEO_ENCODER_BLOCK = 'builtin.videoenc';
/** Strom block that stamps each frame with absolute time, which TAMS Output anchors on. Optional. */
export const TAMS_REFERENCE_TIMESTAMP_BLOCK = 'builtin.reference_timestamp';
/** Strom block the tap encodes audio with: the TAMS block refuses raw audio too. */
export const TAMS_AUDIO_ENCODER_BLOCK = 'builtin.audioenc';

/** One input that is written to TAMS, as reported back from activation. */
export interface ActiveTamsTap {
  mixerInput: string;
  sourceId: string;
  sourceName: string;
  /** The `builtin.tams_output` block of this input in the live flow. */
  tamsBlockId: string;
  /** The TAMS source id the input is stored under; the same on every activation of the production. */
  tamsSourceId: string;
}

export interface PlannedTamsTap {
  assignment: ProductionSourceAssignment;
}

const NAMESPACE = 'b7a2f1c4-5d3e-4a86-9c1f-0e2d7a4b6c13';

/**
 * A stable TAMS source id for a production's input (UUID v5). Re-activating
 * the production writes to the same TAMS source, so its recordings stay
 * together in the store instead of scattering over a new source each time.
 */
export function tamsSourceId(productionId: string, mixerInput: string): string {
  const h = createHash('sha1')
    .update(Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`${productionId}/${mixerInput}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Numeric stored pad index of `video_in_N`, or `Infinity` for anything else. */
function padIndex(mixerInput: string): number {
  const m = /^video_in_(\d+)$/.exec(mixerInput);
  return m ? parseInt(m[1]!, 10) : Number.POSITIVE_INFINITY;
}

/**
 * Which inputs this activation writes to TAMS, and the warnings for the rest.
 * In order:
 *  1. no Strom block list, or no `builtin.tams_output` / `builtin.videoenc` /
 *     `builtin.audioenc` in it: nothing is tapped, `tams-unavailable` (naming a block Strom lacks
 *     makes it refuse the whole flow, so the production goes on air without
 *     the tap);
 *  2. over `maxInputs`: the first N by stored pad index are tapped, the rest
 *     are skipped with `tams-capped`.
 * An assignment whose source is gone is skipped silently: it is not in the
 * flow at all.
 */
export function planTamsTaps(
  assignments: readonly ProductionSourceAssignment[],
  resolveSource: (sourceId: string) => Pick<SourceDoc, 'name'> | undefined,
  opts: { blockIds: ReadonlySet<string> | null; maxInputs: number },
): { taps: PlannedTamsTap[]; warnings: ActivationWarning[]; referenceTimestamp: boolean } {
  const candidates = assignments
    .filter((a) => resolveSource(a.sourceId))
    .sort((a, b) => padIndex(a.mixerInput) - padIndex(b.mixerInput));
  if (candidates.length === 0) return { taps: [], warnings: [], referenceTimestamp: false };
  const asked = candidates.map((a) => a.mixerInput);

  const missing = [TAMS_OUTPUT_BLOCK, TAMS_VIDEO_ENCODER_BLOCK, TAMS_AUDIO_ENCODER_BLOCK].filter((b) => !opts.blockIds?.has(b));
  if (!opts.blockIds || missing.length > 0) {
    return {
      taps: [],
      referenceTimestamp: false,
      warnings: [{
        type: 'tams-unavailable',
        mixerInputs: asked,
        message:
          `Inputs ${asked.join(', ')} are not written to TAMS: ` +
          (opts.blockIds
            ? `this Strom has no ${missing.join(' or ')} block.`
            : "Strom's block list could not be read."),
      }],
    };
  }

  const cap = Math.max(0, opts.maxInputs);
  const warnings: ActivationWarning[] = [];
  if (candidates.length > cap) {
    const skipped = asked.slice(cap);
    warnings.push({
      type: 'tams-capped',
      mixerInputs: skipped,
      message:
        `Inputs ${skipped.join(', ')} are not written to TAMS: at most ${cap} input${cap === 1 ? '' : 's'} ` +
        'can be written per production (TAMS_MAX_INPUTS).',
    });
  }
  return {
    taps: candidates.slice(0, cap).map((assignment) => ({ assignment })),
    warnings,
    // Optional: without it TAMS Output still stamps from the pipeline clock.
    referenceTimestamp: opts.blockIds.has(TAMS_REFERENCE_TIMESTAMP_BLOCK),
  };
}

/** A tag value as Strom's `key=value, key=value` list can carry it: no commas or line breaks. */
export function tamsTagValue(value: string): string {
  return value.replace(/[,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The tags on a tapped input's TAMS flow, so Open Replay can find and group it:
 * the production, and its name as the replay group, the input as the angle, and the
 * Open Live source it carries.
 */
export function tamsTags(opts: {
  productionId: string;
  productionName: string;
  mixerInput: string;
  sourceId: string;
  sourceName: string;
}): string {
  return [
    ['production', opts.productionId],
    ['replay_group', opts.productionName],
    ['angle', opts.mixerInput],
    ['source_name', opts.sourceName],
    ['open_live_source', opts.sourceId],
  ].map(([k, v]) => `${k}=${tamsTagValue(v!)}`).join(', ');
}
