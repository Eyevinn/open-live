/**
 * Reads a recording's duration from its MP4 header (issue #534), so the
 * recordings list can show `durationMs` without probing the object later.
 *
 * Walks the ISO BMFF box tree of an in-memory buffer to `moov/mvhd` and returns
 * `duration / timescale` in milliseconds. A fragmented MP4 whose `mvhd` duration is 0 falls back to
 * `moov/mvex/mehd`'s fragment duration. Returns undefined for anything it
 * cannot read (no `moov`, truncated box, zero timescale) — the caller then
 * simply omits `durationMs`.
 *
 * The uploader streams each segment rather than holding it in memory (issue
 * #552), so it feeds the bytes through `Mp4DurationScanner`, which follows the
 * top-level box headers as they stream past and keeps only the `moov` box —
 * wherever the muxer put it (start or end of the file).
 */

interface Box {
  type: string;
  /** Offset of the box payload (after the size/type header). */
  start: number;
  /** Offset one past the end of the box. */
  end: number;
}

/** Iterates the boxes in `buf[from, to)`; stops at the first malformed one. */
function* boxes(buf: Buffer, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > to) return;
      const large = buf.readBigUInt64BE(pos + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = to - pos; // box extends to the end of its container
    }
    if (size < header || pos + size > to) return;
    yield { type, start: pos + header, end: pos + size };
    pos += size;
  }
}

function child(buf: Buffer, parent: { start: number; end: number }, type: string): Box | undefined {
  for (const box of boxes(buf, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return undefined;
}

/** Reads `(timescale, duration)` from an `mvhd` payload. */
function readMvhd(buf: Buffer, box: Box): { timescale: number; duration: number } | undefined {
  const version = buf.readUInt8(box.start);
  if (version === 1) {
    // version/flags(4) creation(8) modification(8) timescale(4) duration(8)
    if (box.start + 32 > box.end) return undefined;
    return {
      timescale: buf.readUInt32BE(box.start + 20),
      duration: Number(buf.readBigUInt64BE(box.start + 24)),
    };
  }
  // version/flags(4) creation(4) modification(4) timescale(4) duration(4)
  if (box.start + 20 > box.end) return undefined;
  return {
    timescale: buf.readUInt32BE(box.start + 12),
    duration: buf.readUInt32BE(box.start + 16),
  };
}

/** Reads the fragment duration from an `mehd` payload. */
function readMehd(buf: Buffer, box: Box): number | undefined {
  const version = buf.readUInt8(box.start);
  if (version === 1) {
    if (box.start + 12 > box.end) return undefined;
    return Number(buf.readBigUInt64BE(box.start + 4));
  }
  if (box.start + 8 > box.end) return undefined;
  return buf.readUInt32BE(box.start + 4);
}

/** Duration of an MP4 file in milliseconds, or undefined when it cannot be read. */
export function mp4DurationMs(buf: Buffer): number | undefined {
  try {
    const moov = child(buf, { start: 0, end: buf.length }, 'moov');
    if (!moov) return undefined;
    const mvhdBox = child(buf, moov, 'mvhd');
    if (!mvhdBox || mvhdBox.end - mvhdBox.start < 1) return undefined;
    const mvhd = readMvhd(buf, mvhdBox);
    if (!mvhd || mvhd.timescale === 0) return undefined;
    let duration = mvhd.duration;
    // 0 (or all-ones "unknown") in a fragmented file: use the movie-extends header.
    if (duration === 0 || duration === 0xffffffff) {
      const mvex = child(buf, moov, 'mvex');
      const mehdBox = mvex ? child(buf, mvex, 'mehd') : undefined;
      duration = mehdBox ? readMehd(buf, mehdBox) ?? 0 : 0;
    }
    if (!duration || !Number.isFinite(duration)) return undefined;
    return Math.round((duration * 1000) / mvhd.timescale);
  } catch {
    return undefined;
  }
}

/**
 * Upper bound on the `moov` box the streaming scanner will retain. A `moov`
 * larger than this (hours of non-fragmented media with big sample tables) is
 * skipped and the duration reported as unknown rather than buffered.
 */
export const MOOV_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Incremental MP4 duration reader for a file that is only ever seen as a
 * stream of chunks (issue #552). `push()` every chunk in order, then call
 * `finish()`. It walks the top-level box headers as they stream past (skipping
 * box payloads without retaining them) and copies out only the `moov` box,
 * which is then parsed with `mp4DurationMs`. Memory is bounded by
 * `maxMoovBytes` plus a 16-byte header buffer.
 *
 * `finish()` returns undefined — never a guessed value — when there is no
 * `moov`, the top-level box structure is malformed, the stream ended inside
 * `moov`, or the `moov` box exceeds `maxMoovBytes`.
 */
export class Mp4DurationScanner {
  /** Absolute stream offset of the next byte `push()` will see. */
  private pos = 0;
  /** Absolute offset of the next top-level box header. */
  private nextBox = 0;
  /** Header bytes of the current top-level box collected so far. */
  private header = Buffer.alloc(16);
  private headerLen = 0;
  /** The `moov` box being captured (header included), once found. */
  private moov: Buffer | undefined;
  private moovFilled = 0;
  private stopped = false;
  private result: number | undefined;

  constructor(private readonly maxMoovBytes: number = MOOV_MAX_BYTES) {}

  push(chunk: Uint8Array): void {
    let off = 0;
    while (off < chunk.length && !this.stopped) {
      if (this.moov) {
        const take = Math.min(this.moov.length - this.moovFilled, chunk.length - off);
        this.moov.set(chunk.subarray(off, off + take), this.moovFilled);
        this.moovFilled += take;
        off += take;
        if (this.moovFilled === this.moov.length) this.parseMoov();
        continue;
      }
      const abs = this.pos + off;
      if (abs < this.nextBox) {
        off += Math.min(this.nextBox - abs, chunk.length - off);
        continue;
      }
      // At (or inside) a top-level box header: collect 8 bytes, or 16 for a
      // 64-bit largesize box (size field === 1).
      const need = this.headerLen >= 8 && this.header.readUInt32BE(0) === 1 ? 16 : 8;
      const take = Math.min(need - this.headerLen, chunk.length - off);
      this.header.set(chunk.subarray(off, off + take), this.headerLen);
      this.headerLen += take;
      off += take;
      if (this.headerLen < need) continue;
      if (need === 8 && this.header.readUInt32BE(0) === 1) continue; // go read the largesize
      this.onHeader(this.pos + off);
    }
    this.pos += chunk.length;
  }

  /** Handles a complete top-level box header ending at absolute offset `headerEnd`. */
  private onHeader(headerEnd: number): void {
    const headerLen = this.headerLen;
    this.headerLen = 0;
    const boxStart = headerEnd - headerLen;
    const type = this.header.toString('latin1', 4, 8);
    let size = this.header.readUInt32BE(0);
    if (size === 1) {
      const large = this.header.readBigUInt64BE(8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return this.stop();
      size = Number(large);
    }
    // size 0 = box runs to end of file, so nothing can follow it; a `moov` of
    // unknown size is not worth guessing at either.
    if (size === 0 || size < headerLen) return this.stop();
    if (type !== 'moov') {
      this.nextBox = boxStart + size;
      return;
    }
    if (size > this.maxMoovBytes) return this.stop();
    this.moov = Buffer.alloc(size);
    this.header.copy(this.moov, 0, 0, headerLen);
    this.moovFilled = headerLen;
    if (this.moovFilled === size) this.parseMoov();
  }

  private parseMoov(): void {
    this.result = this.moov ? mp4DurationMs(this.moov) : undefined;
    this.stop();
  }

  private stop(): void {
    this.stopped = true;
    this.moov = undefined;
  }

  /** Duration in milliseconds, or undefined when it could not be read. */
  finish(): number | undefined {
    this.moov = undefined;
    return this.result;
  }
}
