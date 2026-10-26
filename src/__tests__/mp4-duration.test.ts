/**
 * mp4DurationMs — reads a recording's duration from its MP4 movie header
 * (issue #534). Most cases use boxes built by hand; the last block reads real
 * files written by Strom's Live Recorder (spec §7, fixtures/live-recorder/).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { mp4DurationMs, Mp4DurationScanner } from '../lib/mp4-duration.js';

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(0, 0); // version 0 + flags
  p.writeUInt32BE(timescale, 12);
  p.writeUInt32BE(duration, 16);
  return box('mvhd', p);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const p = Buffer.alloc(112);
  p.writeUInt8(1, 0);
  p.writeUInt32BE(timescale, 20);
  p.writeBigUInt64BE(duration, 24);
  return box('mvhd', p);
}

function mehdV0(duration: number): Buffer {
  const p = Buffer.alloc(8);
  p.writeUInt32BE(duration, 4);
  return box('mehd', p);
}

const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0isomiso2avc1mp41', 'latin1'));

describe('mp4DurationMs', () => {
  it('reads a version-0 mvhd after a large mdat', () => {
    const mdat = box('mdat', Buffer.alloc(4096));
    const file = Buffer.concat([ftyp, mdat, box('moov', mvhdV0(1000, 61_234), box('trak'))]);
    expect(mp4DurationMs(file)).toBe(61_234);
  });

  it('reads a version-1 mvhd and converts from the timescale', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV1(90_000, 90_000n * 125n))]);
    expect(mp4DurationMs(file)).toBe(125_000);
  });

  it('falls back to mvex/mehd for a fragmented file with a zero mvhd duration', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV0(600, 0), box('mvex', mehdV0(600 * 42)))]);
    expect(mp4DurationMs(file)).toBe(42_000);
  });

  it('handles a 64-bit largesize box before moov', () => {
    const payload = Buffer.alloc(32);
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0);
    header.write('mdat', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
    const file = Buffer.concat([ftyp, header, payload, box('moov', mvhdV0(1000, 5_000))]);
    expect(mp4DurationMs(file)).toBe(5_000);
  });

  it('returns undefined for no moov, a truncated file, a zero timescale or no duration', () => {
    expect(mp4DurationMs(Buffer.concat([ftyp, box('mdat', Buffer.alloc(16))]))).toBeUndefined();
    expect(mp4DurationMs(Buffer.from('not an mp4 at all'))).toBeUndefined();
    expect(mp4DurationMs(Buffer.concat([ftyp, box('moov', mvhdV0(1000, 5_000))]).subarray(0, 60))).toBeUndefined();
    expect(mp4DurationMs(Buffer.concat([ftyp, box('moov', mvhdV0(0, 5_000))]))).toBeUndefined();
    expect(mp4DurationMs(Buffer.concat([ftyp, box('moov', mvhdV0(1000, 0))]))).toBeUndefined();
    expect(mp4DurationMs(Buffer.alloc(0))).toBeUndefined();
  });
});

/**
 * Fragmented MP4 as Live Recorder writes it (OL-32a, spec §7): `isofmp4mux`
 * without `write-mehd`, so `mvhd` duration is 0 and there is no `mehd`; the
 * duration is the sum of the `trun` sample durations per track.
 */
describe('fragmented MP4 without a header duration (Live Recorder)', () => {
  function full(type: string, version: number, flags: number, ...fields: Buffer[]): Buffer {
    const vf = Buffer.alloc(4);
    vf.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
    return box(type, vf, ...fields);
  }
  const u32 = (...vals: number[]) => {
    const b = Buffer.alloc(4 * vals.length);
    vals.forEach((v, i) => b.writeUInt32BE(v, 4 * i));
    return b;
  };
  /** tkhd v0: creation, modification, track_ID, reserved, duration, … */
  const tkhd = (trackId: number) => full('tkhd', 0, 3, u32(0, 0, trackId, 0, 0), Buffer.alloc(60));
  /** mdhd v0: creation, modification, timescale, duration, language/pre_defined */
  const mdhd = (timescale: number) => full('mdhd', 0, 0, u32(0, 0, timescale, 0, 0));
  const trak = (trackId: number, timescale: number) => box('trak', tkhd(trackId), box('mdia', mdhd(timescale)));
  const trex = (trackId: number, defaultDuration: number) => full('trex', 0, 0, u32(trackId, 1, defaultDuration, 0, 0));

  /** Video track 1 @ 90 kHz, per-sample durations in trun (flag 0x100 | 0x200 sizes). */
  function videoTraf(samples: number[]): Buffer {
    const perSample = Buffer.concat(samples.map((d) => u32(d, 100)));
    return box('traf',
      full('tfhd', 0, 0x020000, u32(1)), // default-base-is-moof
      full('tfdt', 1, 0, Buffer.alloc(8)),
      full('trun', 0, 0x000001 | 0x000100 | 0x000200, u32(samples.length, 0), perSample));
  }
  /** Audio track 2 @ 48 kHz, duration from tfhd default (0x08), sizes only in trun. */
  function audioTraf(count: number, defaultDuration: number | undefined): Buffer {
    const tfhdFlags = defaultDuration !== undefined ? 0x08 : 0;
    const tfhdFields = defaultDuration !== undefined ? u32(2, defaultDuration) : u32(2);
    return box('traf',
      full('tfhd', 0, tfhdFlags, tfhdFields),
      full('trun', 0, 0x000200, u32(count), Buffer.concat(Array.from({ length: count }, () => u32(10)))));
  }

  /** ftyp, moov (mvhd duration 0, two traks, mvex/trex, no mehd), then `n` 2-second moof/mdat pairs. */
  function liveRecorderFile(n: number, opts: { audioDefaultInTfhd?: boolean } = {}): Buffer {
    const moov = box('moov', mvhdV0(1000, 0), trak(1, 90_000), trak(2, 48_000),
      box('mvex', trex(1, 3000), trex(2, 1024)));
    const frags: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      // 2 s of 30 fps video = 60 × 3000 ticks; audio 2 s = 93.75 AAC frames → 94 × 1024 ticks.
      const audio = audioTraf(94, opts.audioDefaultInTfhd === false ? undefined : 1024);
      frags.push(box('moof', full('mfhd', 0, 0, u32(i + 1)), videoTraf(Array(60).fill(3000)), audio));
      frags.push(box('mdat', Buffer.alloc(2048)));
    }
    return Buffer.concat([ftyp, moov, ...frags]);
  }

  it('sums the trun durations and returns the longest track', () => {
    // Video 150 × 2 s = 300 000 ms; audio 150 × 94 × 1024 / 48 000 = 300 800 ms (longest).
    expect(mp4DurationMs(liveRecorderFile(150))).toBe(300_800);
  });

  it('uses the trex default when neither trun nor tfhd carries a duration', () => {
    expect(mp4DurationMs(liveRecorderFile(3, { audioDefaultInTfhd: false }))).toBe(Math.round((3 * 94 * 1024 * 1000) / 48_000));
  });

  it('streams the same result in odd chunk sizes without buffering mdat', () => {
    const file = liveRecorderFile(40);
    for (const chunkSize of [1, 7, 4096, file.length]) {
      const s = new Mp4DurationScanner(1 << 20, 64 * 1024);
      for (let off = 0; off < file.length; off += chunkSize) s.push(file.subarray(off, off + chunkSize));
      expect(s.finish()).toBe(Math.round((40 * 94 * 1024 * 1000) / 48_000));
    }
  });

  it('still prefers mvhd/mehd when present', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 7_000), trak(1, 90_000)), box('moof', videoTraf([90_000]))]);
    expect(mp4DurationMs(file)).toBe(7_000);
  });

  it('returns undefined for a malformed trun, a truncated stream or an oversize moof', () => {
    const bad = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 0), trak(1, 90_000), box('mvex', trex(1, 3000))),
      box('moof', box('traf', full('tfhd', 0, 0, u32(1)), full('trun', 0, 0x100, u32(10), u32(3000))))]);
    expect(mp4DurationMs(bad)).toBeUndefined();

    const file = liveRecorderFile(2);
    const truncated = new Mp4DurationScanner();
    truncated.push(file.subarray(0, file.length - 2048 - 20));
    expect(truncated.finish()).toBeUndefined();

    const small = new Mp4DurationScanner(1 << 20, 16);
    small.push(file);
    expect(small.finish()).toBeUndefined();
  });

  describe('track start offset (issue #577)', () => {
    const u64 = (v: number) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(v), 0);
      return b;
    };
    /** Video track 1 @ 90 kHz starting at `tfdt`; optional first-sample composition offset. */
    function videoFrom(tfdt: number, count: number, cto?: number): Buffer {
      const flags = 0x000100 | 0x000200 | (cto !== undefined ? 0x000800 : 0);
      const perSample = Buffer.concat(Array.from({ length: count }, (_, i) =>
        cto !== undefined ? u32(3000, 100, i === 0 ? cto : 0) : u32(3000, 100)));
      return box('traf', full('tfhd', 0, 0x020000, u32(1)), full('tfdt', 1, 0, u64(tfdt)),
        full('trun', 0, flags, u32(count), perSample));
    }
    /** Audio track 2 @ 48 kHz starting at `tfdt` (v0 tfdt), tfhd default duration. */
    function audioFrom(tfdt: number, count: number): Buffer {
      return box('traf', full('tfhd', 0, 0x08, u32(2, 1024)), full('tfdt', 0, 0, u32(tfdt)),
        full('trun', 0, 0x000200, u32(count), Buffer.concat(Array.from({ length: count }, () => u32(10)))));
    }
    /** elst v0 entries: [segment_duration (movie timescale), media_time (track timescale)]. */
    const edts = (...entries: Array<[number, number]>) => box('edts', full('elst', 0, 0,
      u32(entries.length), Buffer.concat(entries.map(([d, m]) => {
        const e = Buffer.alloc(12);
        e.writeUInt32BE(d, 0);
        e.writeInt32BE(m, 4);
        e.writeUInt32BE(0x00010000, 8);
        return e;
      }))));
    function file(frags: Buffer[][], videoEdts?: Buffer): Buffer {
      const videoTrak = videoEdts
        ? box('trak', tkhd(1), videoEdts, box('mdia', mdhd(90_000)))
        : trak(1, 90_000);
      const moov = box('moov', mvhdV0(1000, 0), videoTrak, trak(2, 48_000),
        box('mvex', trex(1, 3000), trex(2, 1024)));
      const parts: Buffer[] = [ftyp, moov];
      frags.forEach((trafs, i) => {
        parts.push(box('moof', full('mfhd', 0, 0, u32(i + 1)), ...trafs), box('mdat', Buffer.alloc(256)));
      });
      return Buffer.concat(parts);
    }
    function scan(buf: Buffer, chunkSize = buf.length): { durationMs?: number; offsetMs?: number } {
      const s = new Mp4DurationScanner();
      for (let off = 0; off < buf.length; off += chunkSize) s.push(buf.subarray(off, off + chunkSize));
      return { durationMs: s.finish(), offsetMs: s.trackStartOffsetMs() };
    }

    it('reports how late the video track starts after the audio (attempt 5: 1.717 s)', () => {
      // Audio starts at 0; video's first sample (the first IDR) at 1.717 s.
      // The first fragment holds only audio, as when the input's video starts late.
      const buf = file([
        [audioFrom(0, 94)],
        [videoFrom(Math.round(1.717 * 90_000), 60), audioFrom(94 * 1024, 94)],
        [videoFrom(Math.round(1.717 * 90_000) + 60 * 3000, 60), audioFrom(188 * 1024, 94)],
      ]);
      for (const chunkSize of [1, 13, 4096, buf.length]) {
        expect(scan(buf, chunkSize)).toEqual({ durationMs: Math.round((3 * 94 * 1024 * 1000) / 48_000), offsetMs: 1_717 });
      }
    });

    it('is 0 when both tracks start together, or for a single-track file', () => {
      expect(scan(file([[videoFrom(0, 60), audioFrom(0, 94)]])).offsetMs).toBe(0);
      expect(scan(file([[videoFrom(450_000, 60)]])).offsetMs).toBe(0);
    });

    it('takes the earliest track as t=0 whichever track starts first', () => {
      // Video first at 0.2 s, audio 0.5 s later.
      expect(scan(file([[videoFrom(18_000, 60), audioFrom(33_600, 94)]])).offsetMs).toBe(500);
    });

    it("adds the first sample's composition offset and applies the edit list", () => {
      // B-frames: first sample presented 2 frames (6000 ticks) after its decode
      // time, and the edit list's media_time removes exactly that delay.
      expect(scan(file([[videoFrom(0, 60, 6000), audioFrom(0, 94)]], edts([0, 6000]))).offsetMs).toBe(0);
      // Without an edit list the composition offset delays video by 66.7 ms.
      expect(scan(file([[videoFrom(0, 60, 6000), audioFrom(0, 94)]])).offsetMs).toBe(67);
      // A leading empty edit of 400 ms (movie timescale 1000) delays video.
      expect(scan(file([[videoFrom(0, 60), audioFrom(0, 94)]], edts([400, -1], [0, 0]))).offsetMs).toBe(400);
    });

    it('is undefined when the header carries the duration, or the file is unreadable', () => {
      const withHeader = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 7_000), trak(1, 90_000), trak(2, 48_000),
        box('mvex', trex(1, 3000), trex(2, 1024))), box('moof', videoFrom(90_000, 60), audioFrom(0, 94))]);
      expect(scan(withHeader)).toEqual({ durationMs: 7_000, offsetMs: undefined });

      const buf = file([[audioFrom(0, 94)], [videoFrom(90_000, 60), audioFrom(94 * 1024, 94)]]);
      const truncated = new Mp4DurationScanner();
      truncated.push(buf.subarray(0, buf.length - 256 - 20));
      expect(truncated.finish()).toBeUndefined();
      expect(truncated.trackStartOffsetMs()).toBeUndefined();
    });
  });
});

/**
 * Real Live Recorder output (spec §7). Two consecutive parts written by
 * `builtin.liverecorder` in Strom v0.7.1 (the `eyevinntechnology/strom:0.7.1-amd64`
 * image, GStreamer 1.26.6), run locally — not the dev Strom. Live Recorder's
 * code is the same in v0.7.1 and in Eyevinn/strom@4abc286. Flow: live
 * videotestsrc → builtin.videoformat 320x180@25 → builtin.videoenc (x264,
 * 200 kbit/s) → video_in_0, and raw live audiotestsrc → audio_in_0 (Live Recorder
 * encodes it to AAC, as for open-live's raw main_out), `max_size_time_secs: 4`.
 *
 * isofmp4mux writes `mvhd` duration 0, no `mehd`, `trex` default 0, and per-traf
 * `tfhd` default durations with several `trun`s that carry no sample durations,
 * so durationMs comes only from the tfhd-default path.
 *
 * ffprobe n8.1.3 on each file (`-show_packets`, `-show_format`):
 * - part-00000: video 120 packets summing to 4.800000 s, audio 206 summing to
 *   4.783320 s; format duration 4.811177 s.
 * - part-00001: video 120 packets summing to 4.800000 s, audio 207 summing to
 *   4.806540 s; format duration 4.844777 s.
 * durationMs is the longest track's sample-duration sum. ffprobe's format
 * duration also counts the first video sample's start offset (5.6 ms and
 * 22.4 ms here), so it may be up to about one frame longer.
 */
describe('fragmented MP4 written by Strom Live Recorder (real fixture)', () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./fixtures/live-recorder/${name}`, import.meta.url));
  const parts = [
    { name: 'part-00000.mp4', longestTrackSumMs: 4_800, ffprobeFormatMs: 4_811.177 },
    { name: 'part-00001.mp4', longestTrackSumMs: 4_806.54, ffprobeFormatMs: 4_844.777 },
  ];

  for (const part of parts) {
    it(`${part.name}: durationMs matches ffprobe`, () => {
      const file = fixture(part.name);
      const ms = mp4DurationMs(file);
      expect(ms).toBe(Math.round(part.longestTrackSumMs));
      expect(Math.abs((ms as number) - part.ffprobeFormatMs)).toBeLessThanOrEqual(40);
    });

    it(`${part.name}: the streaming scanner gives the same value in any chunk size`, () => {
      const file = fixture(part.name);
      for (const chunkSize of [1, 7, 1000, 65_536, file.length]) {
        const s = new Mp4DurationScanner();
        for (let off = 0; off < file.length; off += chunkSize) s.push(file.subarray(off, off + chunkSize));
        expect(s.finish()).toBe(Math.round(part.longestTrackSumMs));
      }
    });
  }

  it('reports the video track starting 5.6 ms / 22.4 ms after the audio (issue #577)', () => {
    // tfdt: part-00000 video 14 @ 2500 Hz, audio 1 @ 44100 Hz; part-00001 video 56, audio 1.
    for (const [name, offsetMs] of [['part-00000.mp4', 6], ['part-00001.mp4', 22]] as const) {
      const file = fixture(name);
      for (const chunkSize of [7, 65_536]) {
        const s = new Mp4DurationScanner();
        for (let off = 0; off < file.length; off += chunkSize) s.push(file.subarray(off, off + chunkSize));
        s.finish();
        expect(s.trackStartOffsetMs()).toBe(offsetMs);
      }
    }
  });

  it('returns undefined for a real part cut off inside a moof', () => {
    const file = fixture('part-00001.mp4');
    const moofAt = file.indexOf('moof', 0, 'latin1') - 4;
    const s = new Mp4DurationScanner();
    s.push(file.subarray(0, moofAt + 100));
    expect(s.finish()).toBeUndefined();
  });
});
