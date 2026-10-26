import type { UploadedSegment } from './recording-uploader.js';
import type { RecorderType, RecordingStartSource } from '../db/types.js';

/** Start and end of one uploaded recording part (ISO 8601). */
export interface PartTiming {
  startedAt?: string;
  /** Undefined when the part's duration is unknown; the caller picks a fallback. */
  endedAt?: string;
}

/** `<stem>_<index>.<ext>`: Strom's recorder numbers a session's parts with `%05d`. */
const PART_NAME = /^(.*)_(\d+)\.[^.]+$/;

/** A recording part's session stem and part index, read from its file name or key. */
export interface PartName {
  stem: string;
  index: number;
}

/**
 * Splits `<stem>_<index>.<ext>` into its stem and part index (issue #556).
 * Returns undefined for a name without a `_<digits>` suffix.
 */
export function parsePartName(name: string): PartName | undefined {
  const m = PART_NAME.exec(name);
  return m ? { stem: m[1], index: Number(m[2]) } : undefined;
}

/**
 * Orders parts by session, then index. Strom stamps the session start into the
 * stem as `YYYYmmdd_HHMMSS`, so a later session sorts after an earlier one.
 */
export function comparePartNames(a: PartName, b: PartName): number {
  if (a.stem !== b.stem) return a.stem < b.stem ? -1 : 1;
  return a.index - b.index;
}

/**
 * Per-part start and end times for uploaded recording parts (issue #553).
 *
 * Strom stamps the session start into the file name once, when the recorder
 * block is built, so every part of one activation carries the same stamp and
 * `seg.startedAt` is the session start, not the part's. This groups parts by
 * that shared stem and offsets part `i` by the summed duration of parts
 * `0..i-1`. A part whose duration is unknown (missing from this upload, or an
 * unreadable header) counts as `segmentSecs`. Parts are numbered from 0
 * (splitmuxsink's default `start-index`).
 *
 * Returns one entry per input segment, in input order. A segment with no
 * `startedAt` or no part index in its name keeps its own `startedAt` untouched.
 */
export function recordingPartTimings(segments: UploadedSegment[], segmentSecs: number): PartTiming[] {
  // Known part durations, per session stem, by part index.
  const durations = new Map<string, Map<number, number>>();
  const parsed = segments.map((seg) => {
    const m = PART_NAME.exec(seg.key);
    if (!m || !seg.startedAt) return undefined;
    const stem = m[1];
    const index = Number(m[2]);
    let byIndex = durations.get(stem);
    if (!byIndex) durations.set(stem, (byIndex = new Map()));
    if (seg.durationMs !== undefined) byIndex.set(index, seg.durationMs);
    return { stem, index };
  });

  const fallbackMs = segmentSecs * 1000;
  return segments.map((seg, i) => {
    const part = parsed[i];
    if (!part || !seg.startedAt) {
      return seg.startedAt ? { startedAt: seg.startedAt } : {};
    }
    const byIndex = durations.get(part.stem)!;
    let offsetMs = 0;
    for (let j = 0; j < part.index; j++) offsetMs += byIndex.get(j) ?? fallbackMs;
    const startMs = Date.parse(seg.startedAt) + offsetMs;
    return {
      startedAt: new Date(startMs).toISOString(),
      ...(seg.durationMs !== undefined ? { endedAt: new Date(startMs + seg.durationMs).toISOString() } : {}),
    };
  });
}

/** When open-live saw a recorder open a file (spec iso-input-recording.md §6). */
export interface PartOpenTime {
  /** Wall-clock ms when open-live received `RecorderFileChanged` for the file (rule 2). */
  openedAtMs: number;
  /** The file's t=0 on the flow's UTC anchor, in µs, when Strom reports it (rule 1, strom#1057). */
  startUtcUs?: number;
}

/** A part whose start is already known, so the next part can chain from it (rule 3). */
export interface KnownPartStart {
  startedAtMs: number;
  durationMs?: number;
  /**
   * The rule the start is anchored on: its own `startedAtSource`, or for a
   * `chained` start its predecessor's anchor. Only a chain not anchored on
   * `filename` is taken ahead of rule 2 (issue #575).
   */
  anchor?: RecordingStartSource;
}

/** {@link PartTiming} plus which rule of spec §6 produced `startedAt`. */
export interface ResolvedPartTiming extends PartTiming {
  /** Absent when no rule applied (no event, no predecessor, no stamp in the name). */
  startedAtSource?: RecordingStartSource;
}

/** Key of one part in a `KnownPartStart` index: session stem + part index. */
export function partKey(part: PartName): string {
  return `${part.stem}\0${part.index}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * How much earlier than its `RecorderFileChanged` a recorder's first part
 * started (issue #577): Live Recorder signals the file only once every track
 * has data, so for an input whose video starts at its first IDR (up to one GOP
 * after the audio) the event arrives about that late after the file's t=0.
 * The correction is the latest-starting track's offset from the earliest
 * (`trackStartOffsetMs`), so the start is anchored on the earliest track.
 * Only for part 0 of a session; 0 when the offset is unknown or implausible
 * (not shorter than the part itself).
 */
function firstPartTrackOffsetMs(seg: UploadedSegment, part: PartName | undefined): number {
  const offset = seg.trackStartOffsetMs;
  if (part?.index !== 0 || offset === undefined || !Number.isFinite(offset) || offset <= 0) return 0;
  if (seg.durationMs !== undefined && offset >= seg.durationMs) return 0;
  return offset;
}

/**
 * Per-part start and end times with the start-time precedence of spec §6
 * (OL-32a), best first:
 *  1. `strom` — the file's own `start_utc_us` from `RecorderFileChanged`;
 *  2. `event` — when open-live received `RecorderFileChanged` for the file;
 *     for a session's first part (index 0), moved earlier by the file's
 *     `trackStartOffsetMs` (issue #577), so later chained parts inherit it;
 *  3. `chained` — the previous part of the same session (stem): its start +
 *     duration, when both are known;
 *  4. `filename` — the session stamp in the name + earlier parts' durations
 *     ({@link recordingPartTimings}).
 *
 * On Live Recorder (`recorderType: 'liverecorder'`) a part after a split
 * (index > 0) takes rule 3 ahead of rule 2 when its predecessor's start is
 * anchored on rule 1 or 2 and its duration is known (issue #575): Live Recorder's
 * parts are gapless, while its `RecorderFileChanged` for a split arrives
 * seconds after the new file's t=0. `builtin.recorder` keeps rule 2 first, as
 * its splits are not gapless (#571). A predecessor started by rule 4 is not
 * chained ahead of rule 2 (nor is a chain from one), so a name-stamp error
 * does not carry forward.
 *
 * `openedAt` is keyed by file base name. `known` holds parts resolved earlier
 * (e.g. uploaded while live) by {@link partKey}; it is updated with every part
 * resolved here, so a batch chains within itself too. `endedAt` is
 * `startedAt + durationMs` when the duration is known, else left unset for the
 * caller's fallback. Returns one entry per segment, in input order.
 */
export function resolvePartTimings(
  segments: UploadedSegment[],
  opts: {
    segmentSecs: number;
    openedAt?: ReadonlyMap<string, PartOpenTime>;
    known?: Map<string, KnownPartStart>;
    /** The block that wrote this activation's parts; `liverecorder` chains split parts first. */
    recorderType?: RecorderType;
  },
): ResolvedPartTiming[] {
  const byName = recordingPartTimings(segments, opts.segmentSecs);
  const known = opts.known ?? new Map<string, KnownPartStart>();
  const out: ResolvedPartTiming[] = new Array(segments.length);
  const order = segments
    .map((seg, i) => ({ i, name: baseName(seg.key), part: parsePartName(baseName(seg.key)) }))
    .sort((a, b) => {
      if (a.part && b.part) return comparePartNames(a.part, b.part);
      return a.part ? -1 : b.part ? 1 : 0;
    });

  for (const { i, name, part } of order) {
    const seg = segments[i]!;
    const open = opts.openedAt?.get(name);
    const prev = part && part.index > 0 ? known.get(partKey({ stem: part.stem, index: part.index - 1 })) : undefined;
    const chainedMs = prev?.durationMs !== undefined ? prev.startedAtMs + prev.durationMs : undefined;
    // Live Recorder split (issue #575): the parts are gapless and the event is late.
    const chainFirst = opts.recorderType === 'liverecorder' && (prev?.anchor === 'strom' || prev?.anchor === 'event');
    let startMs: number | undefined;
    let source: RecordingStartSource | undefined;
    if (open?.startUtcUs !== undefined && Number.isFinite(open.startUtcUs)) {
      startMs = Math.round(open.startUtcUs / 1000);
      source = 'strom';
    } else if (chainFirst && chainedMs !== undefined && Number.isFinite(chainedMs)) {
      startMs = chainedMs;
      source = 'chained';
    } else if (open && Number.isFinite(open.openedAtMs)) {
      startMs = open.openedAtMs - firstPartTrackOffsetMs(seg, part);
      source = 'event';
    } else {
      if (chainedMs !== undefined) {
        startMs = chainedMs;
        source = 'chained';
      } else {
        const fromName = byName[i]?.startedAt;
        if (fromName) {
          startMs = Date.parse(fromName);
          source = 'filename';
        }
      }
    }
    if (startMs === undefined || !Number.isFinite(startMs)) {
      out[i] = {};
      continue;
    }
    if (part) {
      known.set(partKey(part), {
        startedAtMs: startMs,
        ...(seg.durationMs !== undefined ? { durationMs: seg.durationMs } : {}),
        ...(source ? { anchor: source === 'chained' ? prev?.anchor ?? source : source } : {}),
      });
    }
    out[i] = {
      startedAt: new Date(startMs).toISOString(),
      ...(seg.durationMs !== undefined ? { endedAt: new Date(startMs + seg.durationMs).toISOString() } : {}),
      startedAtSource: source,
    };
  }
  return out;
}
