/**
 * Per-part start times for time-based recording parts (issue #553).
 *
 * Strom stamps the session start into every part's name, so the part index and
 * the earlier parts' durations are what make the start times consecutive.
 */
import { describe, it, expect } from 'vitest';
import { recordingPartTimings } from '../lib/recording-parts.js';
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
