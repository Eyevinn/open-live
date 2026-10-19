/**
 * Reads a recording's duration from its MP4 header (issue #534), so the
 * recordings list can show `durationMs` without probing the object later.
 *
 * Walks the ISO BMFF box tree of an in-memory file (the uploader already holds
 * each segment as a Buffer) to `moov/mvhd` and returns `duration / timescale`
 * in milliseconds. A fragmented MP4 whose `mvhd` duration is 0 falls back to
 * `moov/mvex/mehd`'s fragment duration. Returns undefined for anything it
 * cannot read (no `moov`, truncated box, zero timescale) — the caller then
 * simply omits `durationMs`.
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
