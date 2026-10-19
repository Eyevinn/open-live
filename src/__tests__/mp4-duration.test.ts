/**
 * mp4DurationMs — reads a recording's duration from its MP4 movie header
 * (issue #534). Boxes are built by hand so no media fixture is needed.
 */
import { describe, it, expect } from 'vitest';
import { mp4DurationMs } from '../lib/mp4-duration.js';

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
