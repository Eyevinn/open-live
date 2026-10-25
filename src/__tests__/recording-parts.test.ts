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
    expect(known.get(partKey({ stem: STEM, index: 5 }))).toEqual({ startedAtMs: at('2026-10-19T10:50:00.100Z'), durationMs: 1_000 });
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

  it('leaves startedAt unset when no rule applies', () => {
    expect(resolvePartTimings([part(STEM, 0, 1_000, null)], { segmentSecs: 600 })).toEqual([{}]);
  });
});
