/**
 * ISO input recording (OL-32, `docs/specs/iso-input-recording.md`, ADR-011):
 * the rules shared by the flow generator, the assignment routes, the live part
 * upload and the deactivate sweep.
 *
 * An assignment with `record: 'transcode'` whose source is WHIP, SRT or EFP gets
 * its own `builtin.liverecorder` writing both tracks of the input, as it arrived
 * (before the lipsync offset), to `recordings/<productionId>/<mixerInput>/`.
 * Input recorders are built only on the Live Recorder path and only when the
 * production records program: they share program's storage target.
 */
import type {
  ActivationWarning, ActiveInputRecording, ProductionSourceAssignment, RecordableStreamType,
  RecorderType, SourceDoc,
} from '../db/types.js';

/** Source types whose input can be recorded (spec Q6): feeds that arrive, not generated ones. */
export const RECORDABLE_STREAM_TYPES: ReadonlySet<string> = new Set<RecordableStreamType>(['whip', 'srt', 'efp']);

export function isRecordableStreamType(streamType: string | undefined): streamType is RecordableStreamType {
  return streamType !== undefined && RECORDABLE_STREAM_TYPES.has(streamType);
}

/** A stored mixer input key, as the assignment routes accept it. */
export const MIXER_INPUT_RE = /^video_in_\d{1,2}$/;

/** The input recorder's output directory (spec §5.1). */
export function inputRecordingDir(productionId: string, mixerInput: string): string {
  return `recordings/${productionId}/${mixerInput}`;
}

/** The input recorder's file-name prefix: a downloaded file names its production and input. */
export function inputRecordingPrefix(productionId: string, mixerInput: string): string {
  return `${productionId}_${mixerInput}`;
}

/** Numeric stored pad index of `video_in_N`, or `Infinity` for anything else. */
export function storedPadIndex(mixerInput: string): number {
  const m = /^video_in_(\d+)$/.exec(mixerInput);
  return m ? parseInt(m[1]!, 10) : Number.POSITIVE_INFINITY;
}

/** The assignments that ask to be recorded. */
export function recordedAssignments(sources: readonly ProductionSourceAssignment[]): ProductionSourceAssignment[] {
  return sources.filter((s) => s.record === 'transcode');
}

export interface PlannedInputRecording {
  assignment: ProductionSourceAssignment;
  streamType: RecordableStreamType;
}

/**
 * Which inputs this activation records, and the warnings for the rest (spec
 * §2.7, §4.1). In order:
 *  1. an assignment whose source is no longer recordable is skipped with
 *     `input-recording-unsupported-source` (a missing source is skipped
 *     silently — the input is not in the flow at all);
 *  2. without a program recorder (no `recording` output): nothing is recorded,
 *     `input-recording-no-output`;
 *  3. on the `builtin.recorder` path: nothing is recorded,
 *     `input-recording-unavailable`;
 *  4. over `maxInputs`: the first N by numeric stored pad index record, the rest
 *     are skipped with `input-recording-capped`.
 * A production that asks to record no input gets no warning (AC 4).
 */
export function planInputRecordings(
  sources: readonly ProductionSourceAssignment[],
  resolveSource: (sourceId: string) => Pick<SourceDoc, 'streamType' | 'name'> | undefined,
  opts: { recorderType: RecorderType | undefined; maxInputs: number },
): { record: PlannedInputRecording[]; warnings: ActivationWarning[] } {
  const warnings: ActivationWarning[] = [];
  const candidates: PlannedInputRecording[] = [];
  for (const assignment of recordedAssignments(sources)) {
    const source = resolveSource(assignment.sourceId);
    if (!source) continue;
    if (!isRecordableStreamType(source.streamType)) {
      warnings.push({
        type: 'input-recording-unsupported-source',
        mixerInput: assignment.mixerInput,
        sourceId: assignment.sourceId,
        message:
          `Input ${assignment.mixerInput} ("${source.name}") is not recorded: only WHIP, SRT and EFP sources can be ` +
          'recorded to their own files.',
      });
      continue;
    }
    candidates.push({ assignment, streamType: source.streamType });
  }
  if (candidates.length === 0) return { record: [], warnings };
  candidates.sort((a, b) => storedPadIndex(a.assignment.mixerInput) - storedPadIndex(b.assignment.mixerInput));
  const asked = candidates.map((c) => c.assignment.mixerInput);

  if (!opts.recorderType) {
    warnings.push({
      type: 'input-recording-no-output',
      mixerInputs: asked,
      message:
        `Inputs ${asked.join(', ')} are set to record, but the production has no recording output, so nothing ` +
        'is recorded for them. Assign a recording output to record inputs.',
    });
    return { record: [], warnings };
  }
  if (opts.recorderType !== 'liverecorder') {
    warnings.push({
      type: 'input-recording-unavailable',
      mixerInputs: asked,
      message:
        `Inputs ${asked.join(', ')} are not recorded: input recording needs Strom's Live Recorder ` +
        '(builtin.liverecorder, Strom 0.7.0 or later). Program is still recorded.',
    });
    return { record: [], warnings };
  }
  const cap = Math.max(0, opts.maxInputs);
  if (candidates.length > cap) {
    const skipped = asked.slice(cap);
    warnings.push({
      type: 'input-recording-capped',
      mixerInputs: skipped,
      message:
        `Inputs ${skipped.join(', ')} are not recorded: at most ${cap} input${cap === 1 ? '' : 's'} can be ` +
        'recorded per production (RECORDING_MAX_INPUTS).',
    });
  }
  return { record: candidates.slice(0, cap), warnings };
}

/** The `ProductionDoc.inputRecordings` entries a production response may show (spec §3.2). */
export function publicInputRecordings(
  inputs: readonly ActiveInputRecording[] | undefined,
): Array<Omit<ActiveInputRecording, 'recorderBlockId' | 'outputDir'>> | undefined {
  if (!inputs) return undefined;
  return inputs.map(({ recorderBlockId: _b, outputDir: _d, ...rest }) => rest);
}

/** The controller WS `RECORDING_STATE` frame (spec §2.8). */
export function recordingStateMessage(
  doc: { recorderBlockId?: string; inputRecordings?: readonly ActiveInputRecording[] } | undefined,
): { type: 'RECORDING_STATE'; program: boolean; inputs: Array<{ mixerInput: string; sourceId: string; sourceName: string }> } {
  return {
    type: 'RECORDING_STATE',
    program: !!doc?.recorderBlockId,
    inputs: (doc?.inputRecordings ?? []).map(({ mixerInput, sourceId, sourceName }) => ({ mixerInput, sourceId, sourceName })),
  };
}
