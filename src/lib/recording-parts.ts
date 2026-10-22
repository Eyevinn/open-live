import type { UploadedSegment } from './recording-uploader.js';

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
