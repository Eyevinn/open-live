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

  describe("a recorder's first part whose tracks start apart (issue #577)", () => {
    const withOffset = (seg: UploadedSegment, trackStartOffsetMs: number): UploadedSegment => ({ ...seg, trackStartOffsetMs });
    const openedAt = new Map<string, PartOpenTime>([
      [nameOf(0), { openedAtMs: at('2026-10-19T10:00:01.717Z') }],
      [nameOf(1), { openedAtMs: at('2026-10-19T10:05:03.130Z') }],
    ]);

    it('rule 2: part 0 is moved back by the late track offset, and chained parts follow it', () => {
      // Video starts 1717 ms into the file; the event arrived once it did.
      const segs = [withOffset(part(STEM, 0, 300_000), 1_717), part(STEM, 1, 300_000), part(STEM, 2, 1_000)];
      const timings = resolvePartTimings(segs, { segmentSecs: 300, openedAt, recorderType: 'liverecorder' });
      expect(timings[0]).toEqual({ startedAt: '2026-10-19T10:00:00.000Z', endedAt: '2026-10-19T10:05:00.000Z', startedAtSource: 'event' });
      expect(timings[1]).toEqual({ startedAt: '2026-10-19T10:05:00.000Z', endedAt: '2026-10-19T10:10:00.000Z', startedAtSource: 'chained' });
      expect(timings[2]).toEqual({ startedAt: '2026-10-19T10:10:00.000Z', endedAt: '2026-10-19T10:10:01.000Z', startedAtSource: 'chained' });
    });

    it('rule 2: the corrected start is what a later batch chains from (live upload, then deactivate)', () => {
      const known = new Map<string, KnownPartStart>();
      resolvePartTimings([withOffset(part(STEM, 0, 300_000), 1_717)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      expect(known.get(partKey({ stem: STEM, index: 0 }))).toEqual({ startedAtMs: at('2026-10-19T10:00:00.000Z'), durationMs: 300_000, anchor: 'event' });
      const [t] = resolvePartTimings([part(STEM, 1, 300_000)], { segmentSecs: 300, openedAt, known, recorderType: 'liverecorder' });
      expect(t).toMatchObject({ startedAt: '2026-10-19T10:05:00.000Z', startedAtSource: 'chained' });
    });

    it('rule 1 is not corrected', () => {
      const withStrom = new Map<string, PartOpenTime>([
        [nameOf(0), { openedAtMs: at('2026-10-19T10:00:01.717Z'), startUtcUs: at('2026-10-19T10:00:00.003Z') * 1000 }],
      ]);
      const [t] = resolvePartTimings([withOffset(part(STEM, 0, 300_000), 1_717)], { segmentSecs: 300, openedAt: withStrom });
      expect(t).toMatchObject({ startedAt: '2026-10-19T10:00:00.003Z', startedAtSource: 'strom' });
    });

    it('a chained part, or an event-stamped part after the first, is not corrected', () => {
      // Live Recorder: part 1 chains; its own offset is ignored.
      const lr = resolvePartTimings([part(STEM, 0, 300_000), withOffset(part(STEM, 1, 300_000), 900)],
        { segmentSecs: 300, openedAt, recorderType: 'liverecorder' });
      expect(lr[1]).toMatchObject({ startedAt: '2026-10-19T10:05:01.717Z', startedAtSource: 'chained' });
      // builtin.recorder: part 1 keeps rule 2, uncorrected.
      const br = resolvePartTimings([part(STEM, 0, 300_000), withOffset(part(STEM, 1, 300_000), 900)],
        { segmentSecs: 300, openedAt, recorderType: 'recorder' });
      expect(br[1]).toMatchObject({ startedAt: '2026-10-19T10:05:03.130Z', startedAtSource: 'event' });
    });

    it('ignores a zero, missing or implausible offset (not shorter than the part)', () => {
      for (const seg of [part(STEM, 0, 300_000), withOffset(part(STEM, 0, 300_000), 0),
        withOffset(part(STEM, 0, 1_000), 1_717), withOffset(part(STEM, 0, 300_000), Number.NaN)]) {
        const [t] = resolvePartTimings([seg], { segmentSecs: 300, openedAt });
        expect(t).toMatchObject({ startedAt: '2026-10-19T10:00:01.717Z', startedAtSource: 'event' });
      }
    });

    it('rules 3/4 for part 0 without an event are not corrected', () => {
      const [t] = resolvePartTimings([withOffset(part(STEM, 0, 300_000), 1_717)], { segmentSecs: 300 });
      expect(t).toMatchObject({ startedAt: SESSION_START, startedAtSource: 'filename' });
    });

    /**
     * #569 acceptance run attempt 5 (activation 40a6b370), as registered live
     * and at deactivate: event receipt times, exact fMP4 durations, registration
     * times, and the SRT input's video starting 1.717 s into part 0.
     */
    describe('attempt 5 model: SRT input part 0 video starts 1.717 s after audio', () => {
      const SRT = 'prod-c9e7d97b_20261026_132548';
      const srtName = (i: number) => `${SRT}_${String(i).padStart(5, '0')}.mp4`;
      const srtOpened = new Map<string, PartOpenTime>([
        [srtName(0), { openedAtMs: at('2026-10-26T12:25:51.451Z') }],
        // Split events, seconds late; Live Recorder chains ahead of them.
        [srtName(1), { openedAtMs: at('2026-10-26T12:30:55.400Z') }],
        [srtName(2), { openedAtMs: at('2026-10-26T12:35:55.600Z') }],
      ]);
      const srtParts = (offsetMs?: number) => [
        { seg: part(SRT, 0, 301_077), registeredAt: '2026-10-26T12:31:03.000Z', offsetMs },
        { seg: part(SRT, 1, 300_203), registeredAt: '2026-10-26T12:36:03.200Z' },
        { seg: part(SRT, 2, 27_033), registeredAt: '2026-10-26T12:36:18.214Z' },
      ];
      // Program: both tracks start at 0; chained end of its last part.
      const PROGRAM_END = at('2026-10-26T12:36:18.685Z');

      /** Registers the parts one at a time, as the live upload and deactivate sweep do. */
      function register(offsetMs?: number) {
        const known = new Map<string, KnownPartStart>();
        const uploaded: UploadedSegment[] = [];
        return srtParts(offsetMs).map(({ seg, registeredAt, offsetMs: o }) => {
          uploaded.push(o !== undefined ? withOffset(seg, o) : seg);
          const timings = resolvePartTimings([...uploaded], { segmentSecs: 300, openedAt: srtOpened, known, recorderType: 'liverecorder' });
          return { timing: timings[timings.length - 1]!, registeredAt };
        });
      }

      it("without the correction the last part's endedAt is after its registration (the defect)", () => {
        const parts = register();
        expect(parts[2]!.timing.endedAt).toBe('2026-10-26T12:36:19.764Z');
        expect(at(parts[2]!.timing.endedAt!)).toBeGreaterThan(at(parts[2]!.registeredAt));
        expect(at(parts[2]!.timing.endedAt!) - PROGRAM_END).toBeGreaterThan(1_000);
      });

      it('with it, no part ends after it was registered, and the input stays within 1 s of program', () => {
        const parts = register(1_717);
        expect(parts.map((p) => p.timing.startedAtSource)).toEqual(['event', 'chained', 'chained']);
        expect(parts[0]!.timing.startedAt).toBe('2026-10-26T12:25:49.734Z');
        for (const { timing, registeredAt } of parts) {
          expect(at(timing.endedAt!)).toBeLessThanOrEqual(at(registeredAt));
        }
        expect(Math.abs(at(parts[2]!.timing.endedAt!) - PROGRAM_END)).toBeLessThan(1_000);
      });
    });
  });

  it('leaves startedAt unset when no rule applies', () => {
    expect(resolvePartTimings([part(STEM, 0, 1_000, null)], { segmentSecs: 600 })).toEqual([{}]);
  });
});
