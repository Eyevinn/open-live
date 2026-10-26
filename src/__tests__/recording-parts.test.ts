/**
 * Per-part start times for time-based recording parts (issue #553).
 *
 * Strom stamps the session start into every part's name, so the part index and
 * the earlier parts' durations are what make the start times consecutive.
 */
import { describe, it, expect } from 'vitest';
import { recordingPartTimings, resolvePartTimings, partKey, type PartOpenTime, type KnownPartStart } from '../lib/recording-parts.js';
import type { UploadedSegment } from '../lib/recording-uploader.js';

const SESSION_START = '2026-10-19T10:00:00.000Z';

function part(stem: string, index: number, durationMs?: number, startedAt: string | null = SESSION_START): UploadedSegment {
  const name = `${stem}_${String(index).padStart(5, '0')}.mp4`;
  return {
    key: `prod-1/${name}`,
    sizeBytes: 1,
    stromPath: `recordings/prod-1/${name}`,
    ...(startedAt ? { startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

describe('recordingPartTimings (#553)', () => {
  it('gives 3 parts of one session strictly increasing startedAt', () => {
    const stem = 'prod-1_20261019_100000';
    const timings = recordingPartTimings([part(stem, 0, 60_000), part(stem, 1, 60_000), part(stem, 2, 20_000)], 60);
    const starts = timings.map((t) => Date.parse(t.startedAt!));
    expect(starts[0]).toBeLessThan(starts[1]!);
    expect(starts[1]).toBeLessThan(starts[2]!);
    expect(timings).toEqual([
      { startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:01:00.000Z' },
      { startedAt: '2026-10-19T10:01:00.000Z', endedAt: '2026-10-19T10:02:00.000Z' },
      { startedAt: '2026-10-19T10:02:00.000Z', endedAt: '2026-10-19T10:02:20.000Z' },
    ]);
  });

  it('returns timings in input order when parts arrive unsorted', () => {
    const stem = 'prod-1_20261019_100000';
    const timings = recordingPartTimings([part(stem, 2, 1_000), part(stem, 0, 30_000), part(stem, 1, 45_000)], 600);
    expect(timings.map((t) => t.startedAt)).toEqual([
      '2026-10-19T10:01:15.000Z',
      '2026-10-19T10:00:00.000Z',
      '2026-10-19T10:00:30.000Z',
    ]);
  });

  it('counts a part with unknown or missing duration as segmentSecs', () => {
    const stem = 'prod-1_20261019_100000';
    // Part 0 is absent (e.g. uploaded by an earlier sweep); part 1 has no readable duration.
    const timings = recordingPartTimings([part(stem, 1), part(stem, 2, 5_000)], 60);
    expect(timings).toEqual([
      { startedAt: '2026-10-19T10:01:00.000Z' },
      { startedAt: '2026-10-19T10:02:00.000Z', endedAt: '2026-10-19T10:02:05.000Z' },
    ]);
  });

  it('keeps sessions with different stems independent', () => {
    const a = part('prod-1_20261019_100000', 1, 10_000);
    const b = part('prod-1_20261019_110000', 0, 10_000, '2026-10-19T11:00:00.000Z');
    const a0 = part('prod-1_20261019_100000', 0, 50_000);
    const timings = recordingPartTimings([a, b, a0], 600);
    expect(timings.map((t) => t.startedAt)).toEqual([
      '2026-10-19T10:00:50.000Z',
      '2026-10-19T11:00:00.000Z',
      '2026-10-19T10:00:00.000Z',
    ]);
  });

  it('leaves a segment without a name stamp or part index unchanged', () => {
    const noStamp = part('prod-1_20261019_100000', 3, 1_000, null);
    const noIndex: UploadedSegment = { key: 'prod-1/seg.mp4', sizeBytes: 1, stromPath: 'recordings/prod-1/seg.mp4', startedAt: SESSION_START };
    expect(recordingPartTimings([noStamp, noIndex], 60)).toEqual([{}, { startedAt: SESSION_START }]);
  });
});

describe('resolvePartTimings — start-time precedence (OL-32a, spec §6)', () => {
  const STEM = 'prod-1_20261019_100000';
  const nameOf = (i: number) => `${STEM}_${String(i).padStart(5, '0')}.mp4`;
  const at = (iso: string) => Date.parse(iso);

  it('rule 1: Strom start_utc_us wins over the receipt time', () => {
    const openedAt = new Map<string, PartOpenTime>([
      [nameOf(0), { openedAtMs: at('2026-10-19T10:00:00.080Z'), startUtcUs: at('2026-10-19T10:00:00.003Z') * 1000 }],
    ]);
    const [t] = resolvePartTimings([part(STEM, 0, 60_000)], { segmentSecs: 600, openedAt });
    expect(t).toEqual({ startedAt: '2026-10-19T10:00:00.003Z', endedAt: '2026-10-19T10:01:00.003Z', startedAtSource: 'strom' });
  });

  it('rule 2: the receipt time of RecorderFileChanged', () => {
    const openedAt = new Map<string, PartOpenTime>([[nameOf(1), { openedAtMs: at('2026-10-19T10:10:00.064Z') }]]);
    const [t] = resolvePartTimings([part(STEM, 1, 600_000)], { segmentSecs: 600, openedAt });
    expect(t).toMatchObject({ startedAt: '2026-10-19T10:10:00.064Z', startedAtSource: 'event' });
  });

  it('rule 3: chains from the previous part of the same session, within a batch and from `known`', () => {
    const openedAt = new Map<string, PartOpenTime>([[nameOf(0), { openedAtMs: at('2026-10-19T10:00:00.050Z') }]]);
    const timings = resolvePartTimings([part(STEM, 1, 600_000), part(STEM, 0, 599_990)], { segmentSecs: 600, openedAt });
    // Input order is kept; part 1 starts where part 0 (event) ended.
    expect(timings[1]).toMatchObject({ startedAt: '2026-10-19T10:00:00.050Z', startedAtSource: 'event' });
    expect(timings[0]).toMatchObject({ startedAt: '2026-10-19T10:10:00.040Z', startedAtSource: 'chained' });

    const known = new Map<string, KnownPartStart>([
      [partKey({ stem: STEM, index: 4 }), { startedAtMs: at('2026-10-19T10:40:00.100Z'), durationMs: 600_000 }],
    ]);
    const [t] = resolvePartTimings([part(STEM, 5, 1_000)], { segmentSecs: 600, known });
    expect(t).toMatchObject({ startedAt: '2026-10-19T10:50:00.100Z', startedAtSource: 'chained' });
    // The resolved part is recorded for the next one.
    expect(known.get(partKey({ stem: STEM, index: 5 }))).toEqual({ startedAtMs: at('2026-10-19T10:50:00.100Z'), durationMs: 1_000, anchor: 'chained' });
  });

  it('rule 3 needs the predecessor duration; otherwise rule 4 (file name) applies', () => {
    const known = new Map<string, KnownPartStart>([[partKey({ stem: STEM, index: 0 }), { startedAtMs: at('2026-10-19T10:00:00.100Z') }]]);
    const [t] = resolvePartTimings([part(STEM, 1, 600_000)], { segmentSecs: 600, known });
    // Name stamp + RECORDING_SEGMENT_SECS for the unknown part 0.
    expect(t).toMatchObject({ startedAt: '2026-10-19T10:10:00.000Z', startedAtSource: 'filename' });
  });

  it('rule 4: the name stamp offset by earlier parts, as before OL-32a', () => {
    const timings = resolvePartTimings([part(STEM, 0, 60_000), part(STEM, 1)], { segmentSecs: 600 });
    expect(timings[0]).toEqual({ startedAt: SESSION_START, endedAt: '2026-10-19T10:01:00.000Z', startedAtSource: 'filename' });
    // Part 1 chains from part 0 (whose start is known from its name and duration).
    expect(timings[1]).toEqual({ startedAt: '2026-10-19T10:01:00.000Z', startedAtSource: 'chained' });
  });

  describe('a part after a split (issue #575)', () => {
    // Part 0 opened at 10:00:00.050 and is exactly 300 s long, so part 1's
    // media starts at 10:05:00.050. Its RecorderFileChanged arrived 3.08 s late,
    // as measured on Live Recorder in the #569 acceptance run.
    const openedAt = new Map<string, PartOpenTime>([
      [nameOf(0), { openedAtMs: at('2026-10-19T10:00:00.050Z') }],
      [nameOf(1), { openedAtMs: at('2026-10-19T10:05:03.130Z') }],
      [nameOf(2), { openedAtMs: at('2026-10-19T10:10:04.900Z') }],
    ]);
    const parts = () => [part(STEM, 0, 300_000), part(STEM, 1, 300_000), part(STEM, 2, 1_000)];

    it('Live Recorder: a late file-changed event does not shift startedAt; the part chains from its predecessor', () => {
      const timings = resolvePartTimings(parts(), { segmentSecs: 300, openedAt, recorderType: 'liverecorder' });
      // First-part behaviour is unchanged: the event time.
      expect(timings[0]).toEqual({ startedAt: '2026-10-19T10:00:00.050Z', endedAt: '2026-10-19T10:05:00.050Z', startedAtSource: 'event' });
      expect(timings[1]).toEqual({ startedAt: '2026-10-19T10:05:00.050Z', endedAt: '2026-10-19T10:10:00.050Z', startedAtSource: 'chained' });
      expect(timings[2]).toEqual({ startedAt: '2026-10-19T10:10:00.050Z', endedAt: '2026-10-19T10:10:01.050Z', startedAtSource: 'chained' });
    });

    it('Live Recorder: chains from a predecessor registered earlier (live upload, then deactivate)', () => {
      const known = new Map<string, KnownPartStart>();
      resolvePartTimings([part(STEM, 0, 300_000)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      const [t] = resolvePartTimings([part(STEM, 1, 300_000)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      expect(t).toMatchObject({ startedAt: '2026-10-19T10:05:00.050Z', startedAtSource: 'chained' });
    });

    it("Live Recorder: Strom's start_utc_us still wins over the chain", () => {
      const withStrom = new Map(openedAt);
      withStrom.set(nameOf(1), { openedAtMs: at('2026-10-19T10:05:03.130Z'), startUtcUs: at('2026-10-19T10:05:00.051Z') * 1000 });
      const timings = resolvePartTimings(parts(), { segmentSecs: 300, openedAt: withStrom, recorderType: 'liverecorder' });
      expect(timings[1]).toMatchObject({ startedAt: '2026-10-19T10:05:00.051Z', startedAtSource: 'strom' });
      expect(timings[2]).toMatchObject({ startedAt: '2026-10-19T10:10:00.051Z', startedAtSource: 'chained' });
    });

    it('Live Recorder: falls back to the event when the predecessor has no duration', () => {
      const timings = resolvePartTimings([part(STEM, 0), part(STEM, 1, 300_000)], { segmentSecs: 300, openedAt, recorderType: 'liverecorder' });
      expect(timings[1]).toMatchObject({ startedAt: '2026-10-19T10:05:03.130Z', startedAtSource: 'event' });
    });

    it('Live Recorder: does not chain ahead of the event from a start anchored on the file name', () => {
      // Part 0 opened before open-live subscribed (rule 4); part 1 without an
      // event chains from it (rule 3); part 2's event must not be overridden.
      const noEarly = new Map<string, PartOpenTime>([[nameOf(2), { openedAtMs: at('2026-10-19T10:10:04.900Z') }]]);
      const timings = resolvePartTimings(parts(), { segmentSecs: 300, openedAt: noEarly, recorderType: 'liverecorder' });
      expect(timings[0]).toMatchObject({ startedAtSource: 'filename' });
      expect(timings[1]).toMatchObject({ startedAtSource: 'chained' });
      expect(timings[2]).toMatchObject({ startedAt: '2026-10-19T10:10:04.900Z', startedAtSource: 'event' });
    });

    it('builtin.recorder (or unknown) keeps the event first', () => {
      for (const recorderType of ['recorder', undefined] as const) {
        const timings = resolvePartTimings(parts(), { segmentSecs: 300, openedAt, ...(recorderType ? { recorderType } : {}) });
        expect(timings[1]).toMatchObject({ startedAt: '2026-10-19T10:05:03.130Z', startedAtSource: 'event' });
      }
    });
  });

  describe("a recorder's first part keeps the uncorrected event start (issue #579, reverts #578)", () => {
    // #569 attempt 6, SRT input: RecorderFileChanged for part 0 arrived at
    // 14:24:58.971 and the file's video started 0.981 s after its audio. #578
    // moved the start back by that offset, to 14:24:57.990, which put the input
    // about 1.1 s early against program. The start is the event receipt again.
    const SRT_STEM = 'prod-1_20261026_142458';
    const srtName = (i: number) => `${SRT_STEM}_${String(i).padStart(5, '0')}.mp4`;
    const openedAt = new Map<string, PartOpenTime>([
      [srtName(0), { openedAtMs: at('2026-10-26T14:24:58.971Z') }],
      [srtName(1), { openedAtMs: at('2026-10-26T14:30:02.100Z') }],
    ]);
    // A segment carrying a late-track offset, as #578's uploader produced it. The field no longer
    // exists on UploadedSegment, hence the cast: it guards against #578's correction returning.
    const withTrackOffset = (seg: UploadedSegment, trackStartOffsetMs: number) =>
      ({ ...seg, trackStartOffsetMs }) as UploadedSegment;

    it('rule 2 part 0 is not shifted by the track offset, and chained parts follow the event start', () => {
      const timings = resolvePartTimings(
        [withTrackOffset(part(SRT_STEM, 0, 300_000), 981), part(SRT_STEM, 1, 300_000)],
        { segmentSecs: 300, openedAt, recorderType: 'liverecorder' },
      );
      expect(timings[0]).toEqual({ startedAt: '2026-10-26T14:24:58.971Z', endedAt: '2026-10-26T14:29:58.971Z', startedAtSource: 'event' });
      expect(timings[1]).toMatchObject({ startedAt: '2026-10-26T14:29:58.971Z', startedAtSource: 'chained' });
    });

    it('the uncorrected start is what later batches chain from (live upload, then deactivate)', () => {
      const known = new Map<string, KnownPartStart>();
      resolvePartTimings([withTrackOffset(part(SRT_STEM, 0, 300_000), 981)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      expect(known.get(partKey({ stem: SRT_STEM, index: 0 }))).toEqual({
        startedAtMs: at('2026-10-26T14:24:58.971Z'),
        durationMs: 300_000,
        anchor: 'event',
      });
      const [t] = resolvePartTimings([part(SRT_STEM, 1, 300_000)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      expect(t).toMatchObject({ startedAt: '2026-10-26T14:29:58.971Z', startedAtSource: 'chained' });
    });

    it('builtin.recorder part 0 also keeps the event start', () => {
      const [t] = resolvePartTimings([withTrackOffset(part(SRT_STEM, 0, 300_000), 1_717)], { segmentSecs: 300, openedAt, recorderType: 'recorder' });
      expect(t).toMatchObject({ startedAt: '2026-10-26T14:24:58.971Z', startedAtSource: 'event' });
    });
  });

  it('leaves startedAt unset when no rule applies', () => {
    expect(resolvePartTimings([part(STEM, 0, 1_000, null)], { segmentSecs: 600 })).toEqual([{}]);
  });
});
