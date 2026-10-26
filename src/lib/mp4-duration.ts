/**
 * Reads a recording's duration from its MP4 header (issue #534), so the
 * recordings list can show `durationMs` without probing the object later.
 *
 * Walks the ISO BMFF box tree of an in-memory buffer to `moov/mvhd` and returns
 * `duration / timescale` in milliseconds. A fragmented MP4 whose `mvhd` duration is 0 falls back to
 * `moov/mvex/mehd`'s fragment duration, and when that is absent too — Live
 * Recorder's `isofmp4mux` writes neither (OL-32a, spec iso-input-recording.md
 * §7) — to the sum of the sample durations in the `moof/traf/trun` boxes, per
 * track in its `mdhd` timescale, taking the longest track. Returns undefined
 * for anything it cannot read (no `moov`, truncated box, zero timescale) — the
 * caller then simply omits `durationMs`.
 *
 * The uploader streams each segment rather than holding it in memory (issue
 * #552), so it feeds the bytes through `Mp4DurationScanner`, which follows the
 * top-level box headers as they stream past and keeps only the `moov` box —
 * wherever the muxer put it (start or end of the file) — and, for a
 * fragmented file, each `moof` box in turn (never an `mdat` payload).
 *
 * From the same fragments it also reports how far the latest-starting track's
 * first sample lies after the earliest track's (issue #577), which corrects a
 * first part's event-stamped start time (spec iso-input-recording.md §6).
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

/** Reads `timescale` from an `mdhd` payload (same layout as `mvhd` up to it). */
function readMdhdTimescale(buf: Buffer, box: Box): number | undefined {
  if (box.end - box.start < 1) return undefined;
  const version = buf.readUInt8(box.start);
  const at = version === 1 ? box.start + 20 : box.start + 12;
  if (at + 4 > box.end) return undefined;
  return buf.readUInt32BE(at);
}

/** Reads `track_ID` from a `tkhd` payload. */
function readTkhdTrackId(buf: Buffer, box: Box): number | undefined {
  if (box.end - box.start < 1) return undefined;
  const version = buf.readUInt8(box.start);
  const at = version === 1 ? box.start + 20 : box.start + 12;
  if (at + 4 > box.end) return undefined;
  return buf.readUInt32BE(at);
}

/** What the `moov` box says about the file's duration. */
interface MoovInfo {
  /** `mvhd` duration (or `mehd` for a fragmented file), in ms; undefined when 0/unknown. */
  headerDurationMs: number | undefined;
  /** The file has `mvex`, so its media may be in fragments. */
  fragmented: boolean;
  /** Per `track_ID`: the `mdhd` timescale, the `trex` default sample duration and the edit list. */
  tracks: Map<number, TrackInfo>;
}

interface TrackInfo {
  timescale?: number;
  defaultSampleDuration?: number;
  /** Presentation time before the track starts, from leading empty `elst` edits, in ms. */
  emptyEditMs?: number;
  /** `media_time` of the first non-empty `elst` edit, in track timescale ticks. */
  editMediaTime?: number;
}

/** Reads a track's `edts/elst`: leading empty edits (ms) and the first edit's `media_time`. */
function readElst(buf: Buffer, box: Box, movieTimescale: number): Pick<TrackInfo, 'emptyEditMs' | 'editMediaTime'> {
  if (box.start + 8 > box.end) return {};
  const version = buf.readUInt8(box.start);
  const count = buf.readUInt32BE(box.start + 4);
  const entrySize = version === 1 ? 20 : 12;
  let emptyTicks = 0;
  let at = box.start + 8;
  for (let i = 0; i < count && at + entrySize <= box.end; i++, at += entrySize) {
    const segmentDuration = version === 1 ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);
    const mediaTime = version === 1 ? Number(buf.readBigInt64BE(at + 8)) : buf.readInt32BE(at + 4);
    if (mediaTime === -1) {
      emptyTicks += segmentDuration;
      continue;
    }
    return { emptyEditMs: (emptyTicks * 1000) / movieTimescale, editMediaTime: mediaTime };
  }
  return emptyTicks > 0 ? { emptyEditMs: (emptyTicks * 1000) / movieTimescale } : {};
}

function readMoov(buf: Buffer, moov: Box): MoovInfo | undefined {
  const mvhdBox = child(buf, moov, 'mvhd');
  if (!mvhdBox || mvhdBox.end - mvhdBox.start < 1) return undefined;
  const mvhd = readMvhd(buf, mvhdBox);
  if (!mvhd || mvhd.timescale === 0) return undefined;
  const mvex = child(buf, moov, 'mvex');
  let duration = mvhd.duration;
  // 0 (or all-ones "unknown") in a fragmented file: use the movie-extends header.
  if (duration === 0 || duration === 0xffffffff) {
    const mehdBox = mvex ? child(buf, mvex, 'mehd') : undefined;
    duration = mehdBox ? readMehd(buf, mehdBox) ?? 0 : 0;
  }
  const headerDurationMs = duration && Number.isFinite(duration)
    ? Math.round((duration * 1000) / mvhd.timescale)
    : undefined;

  const tracks: MoovInfo['tracks'] = new Map();
  for (const box of boxes(buf, moov.start, moov.end)) {
    if (box.type !== 'trak') continue;
    const tkhd = child(buf, box, 'tkhd');
    const trackId = tkhd ? readTkhdTrackId(buf, tkhd) : undefined;
    if (trackId === undefined) continue;
    const mdia = child(buf, box, 'mdia');
    const mdhd = mdia ? child(buf, mdia, 'mdhd') : undefined;
    const timescale = mdhd ? readMdhdTimescale(buf, mdhd) : undefined;
    const edts = child(buf, box, 'edts');
    const elst = edts ? child(buf, edts, 'elst') : undefined;
    tracks.set(trackId, {
      ...tracks.get(trackId),
      ...(timescale ? { timescale } : {}),
      ...(elst ? readElst(buf, elst, mvhd.timescale) : {}),
    });
  }
  if (mvex) {
    for (const box of boxes(buf, mvex.start, mvex.end)) {
      // trex: version/flags(4) track_ID(4) default_sample_description_index(4) default_sample_duration(4)
      if (box.type !== 'trex' || box.start + 16 > box.end) continue;
      const trackId = buf.readUInt32BE(box.start + 4);
      const defaultSampleDuration = buf.readUInt32BE(box.start + 12);
      tracks.set(trackId, { ...tracks.get(trackId), defaultSampleDuration });
    }
  }
  return { headerDurationMs, fragmented: mvex !== undefined, tracks };
}

/**
 * Sample durations summed from `moof` boxes, per `track_ID`, in track
 * timescale ticks. Samples whose duration is only given by the `trex` default
 * (known once `moov` is read, which may come later) are counted separately.
 */
interface FragmentTotals {
  ticks: Map<number, number>;
  samplesWithTrexDefault: Map<number, number>;
  /**
   * Per `track_ID`, from the first `traf` of the track: its `tfdt` decode time
   * (0 when absent) plus the first sample's composition time offset, in track
   * timescale ticks — the track's first presentation time before the edit list
   * (issue #577).
   */
  firstSampleTime: Map<number, number>;
}

function newFragmentTotals(): FragmentTotals {
  return { ticks: new Map(), samplesWithTrexDefault: new Map(), firstSampleTime: new Map() };
}

/** `baseMediaDecodeTime` of a `tfdt` payload, or undefined when truncated. */
function readTfdt(buf: Buffer, box: Box): number | undefined {
  if (box.start + 8 > box.end) return undefined;
  if (buf.readUInt8(box.start) === 1) {
    if (box.start + 12 > box.end) return undefined;
    return Number(buf.readBigUInt64BE(box.start + 4));
  }
  return buf.readUInt32BE(box.start + 4);
}

function addTo(map: Map<number, number>, key: number, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Adds one `moof` box's sample durations to `totals`. Returns false when it is malformed. */
function addMoof(buf: Buffer, moof: Box, totals: FragmentTotals): boolean {
  for (const traf of boxes(buf, moof.start, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = child(buf, traf, 'tfhd');
    if (!tfhd || tfhd.start + 8 > tfhd.end) return false;
    // tfhd: version/flags(4) track_ID(4) [base_data_offset(8)] [sample_description_index(4)]
    //       [default_sample_duration(4)] …
    const tfhdFlags = buf.readUInt32BE(tfhd.start) & 0xffffff;
    const trackId = buf.readUInt32BE(tfhd.start + 4);
    const firstTraf = !totals.firstSampleTime.has(trackId);
    let firstTime: number | undefined;
    if (firstTraf) {
      const tfdt = child(buf, traf, 'tfdt');
      firstTime = tfdt ? readTfdt(buf, tfdt) : 0;
      if (firstTime === undefined) return false;
    }
    let at = tfhd.start + 8;
    if (tfhdFlags & 0x01) at += 8;
    if (tfhdFlags & 0x02) at += 4;
    let defaultDuration: number | undefined;
    if (tfhdFlags & 0x08) {
      if (at + 4 > tfhd.end) return false;
      defaultDuration = buf.readUInt32BE(at);
    }
    for (const trun of boxes(buf, traf.start, traf.end)) {
      if (trun.type !== 'trun') continue;
      // trun: version/flags(4) sample_count(4) [data_offset(4)] [first_sample_flags(4)] then per sample:
      //       [duration(4)] [size(4)] [flags(4)] [composition_time_offset(4)]
      if (trun.start + 8 > trun.end) return false;
      const flags = buf.readUInt32BE(trun.start) & 0xffffff;
      const count = buf.readUInt32BE(trun.start + 4);
      if (firstTime !== undefined && count > 0) {
        // The track's first sample: its decode time plus its composition offset (B-frames).
        let cto = 0;
        if (flags & 0x800) {
          let at = trun.start + 8 + (flags & 0x01 ? 4 : 0) + (flags & 0x04 ? 4 : 0);
          at += 4 * [0x100, 0x200, 0x400].filter((f) => flags & f).length;
          if (at + 4 > trun.end) return false;
          cto = buf.readUInt8(trun.start) === 1 ? buf.readInt32BE(at) : buf.readUInt32BE(at);
        }
        totals.firstSampleTime.set(trackId, firstTime + cto);
        firstTime = undefined;
      }
      if (!(flags & 0x100)) {
        if (defaultDuration !== undefined) addTo(totals.ticks, trackId, count * defaultDuration);
        else addTo(totals.samplesWithTrexDefault, trackId, count);
        continue;
      }
      let pos = trun.start + 8;
      if (flags & 0x01) pos += 4;
      if (flags & 0x04) pos += 4;
      const stride = 4 * [0x100, 0x200, 0x400, 0x800].filter((f) => flags & f).length;
      if (pos + count * stride > trun.end) return false;
      let sum = 0;
      for (let i = 0; i < count; i++, pos += stride) sum += buf.readUInt32BE(pos);
      addTo(totals.ticks, trackId, sum);
    }
  }
  return true;
}

/** Longest track's summed fragment duration in ms, or undefined when no track can be timed. */
function fragmentDurationMs(info: MoovInfo, totals: FragmentTotals): number | undefined {
  let longest: number | undefined;
  const ids = new Set([...totals.ticks.keys(), ...totals.samplesWithTrexDefault.keys()]);
  for (const id of ids) {
    const track = info.tracks.get(id);
    if (!track?.timescale) continue;
    let ticks = totals.ticks.get(id) ?? 0;
    const pending = totals.samplesWithTrexDefault.get(id) ?? 0;
    if (pending > 0) {
      if (track.defaultSampleDuration === undefined) continue;
      ticks += pending * track.defaultSampleDuration;
    }
    const ms = Math.round((ticks * 1000) / track.timescale);
    if (ms > 0 && Number.isFinite(ms) && (longest === undefined || ms > longest)) longest = ms;
  }
  return longest;
}

/**
 * How far the latest-starting track's first sample lies after the earliest
 * track's, in ms (issue #577): the presentation start of each track timed from
 * its first `traf` (`tfdt` + first composition offset) through its edit list.
 * 0 for a file with one timed track; undefined when no track can be timed.
 */
function trackStartOffsetMs(info: MoovInfo, totals: FragmentTotals): number | undefined {
  let earliest: number | undefined;
  let latest: number | undefined;
  for (const [id, ticks] of totals.firstSampleTime) {
    const track = info.tracks.get(id);
    if (!track?.timescale) continue;
    const ms = (track.emptyEditMs ?? 0) + ((ticks - (track.editMediaTime ?? 0)) * 1000) / track.timescale;
    if (!Number.isFinite(ms)) continue;
    if (earliest === undefined || ms < earliest) earliest = ms;
    if (latest === undefined || ms > latest) latest = ms;
  }
  return earliest === undefined || latest === undefined ? undefined : Math.round(latest - earliest);
}

/** Duration of an MP4 file in milliseconds, or undefined when it cannot be read. */
export function mp4DurationMs(buf: Buffer): number | undefined {
  try {
    const top = { start: 0, end: buf.length };
    const moov = child(buf, top, 'moov');
    if (!moov) return undefined;
    const info = readMoov(buf, moov);
    if (!info) return undefined;
    if (info.headerDurationMs !== undefined) return info.headerDurationMs;
    if (!info.fragmented) return undefined;
    const totals = newFragmentTotals();
    for (const box of boxes(buf, 0, buf.length)) {
      if (box.type === 'moof' && !addMoof(buf, box, totals)) return undefined;
    }
    return fragmentDurationMs(info, totals);
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
 * Upper bound on one `moof` box the streaming scanner will retain (OL-32a).
 * A fragment's sample table is a few KiB; a larger `moof` makes the duration
 * unknown rather than being buffered.
 */
export const MOOF_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Incremental MP4 duration reader for a file that is only ever seen as a
 * stream of chunks (issue #552). `push()` every chunk in order, then call
 * `finish()`. It walks the top-level box headers as they stream past (skipping
 * box payloads without retaining them) and copies out only the `moov` box and,
 * for a fragmented file whose headers carry no duration (OL-32a), each `moof`
 * box, which are parsed and dropped one at a time. Memory is bounded by
 * `maxMoovBytes` (or `maxMoofBytes`) plus a 16-byte header buffer.
 *
 * `finish()` returns undefined — never a guessed value — when there is no
 * `moov`, the top-level box structure is malformed, the stream ended inside a
 * captured box, or a captured box exceeds its bound.
 */
export class Mp4DurationScanner {
  /** Absolute stream offset of the next byte `push()` will see. */
  private pos = 0;
  /** Absolute offset of the next top-level box header. */
  private nextBox = 0;
  /** Header bytes of the current top-level box collected so far. */
  private header = Buffer.alloc(16);
  private headerLen = 0;
  /** The `moov` or `moof` box being captured (header included). */
  private capture: Buffer | undefined;
  private captureType = '';
  private captureFilled = 0;
  private stopped = false;
  /** Set when the result can no longer be trusted (malformed, oversize, truncated). */
  private broken = false;
  private moovInfo: MoovInfo | undefined;
  private result: number | undefined;
  private readonly fragments = newFragmentTotals();

  constructor(
    private readonly maxMoovBytes: number = MOOV_MAX_BYTES,
    private readonly maxMoofBytes: number = MOOF_MAX_BYTES,
  ) {}

  push(chunk: Uint8Array): void {
    let off = 0;
    while (off < chunk.length && !this.stopped) {
      if (this.capture) {
        const take = Math.min(this.capture.length - this.captureFilled, chunk.length - off);
        this.capture.set(chunk.subarray(off, off + take), this.captureFilled);
        this.captureFilled += take;
        off += take;
        if (this.captureFilled === this.capture.length) this.parseCapture();
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
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return this.fail();
      size = Number(large);
    }
    const captured = type === 'moov' || type === 'moof';
    if (size === 0) {
      // Box runs to end of file, so nothing can follow it; a captured box of
      // unknown size is not worth guessing at. Fragments seen so far stand.
      return captured ? this.fail() : this.stop();
    }
    if (size < headerLen) return this.fail();
    if (!captured) {
      this.nextBox = boxStart + size;
      return;
    }
    if (size > (type === 'moov' ? this.maxMoovBytes : this.maxMoofBytes)) return this.fail();
    this.capture = Buffer.alloc(size);
    this.captureType = type;
    this.header.copy(this.capture, 0, 0, headerLen);
    this.captureFilled = headerLen;
    this.nextBox = boxStart + size;
    if (this.captureFilled === size) this.parseCapture();
  }

  private parseCapture(): void {
    const buf = this.capture!;
    this.capture = undefined;
    const whole = { type: this.captureType, start: 0, end: buf.length };
    // Re-walk the captured box from its own header to get its payload bounds.
    const box = boxes(buf, whole.start, whole.end).next().value as Box | undefined;
    if (!box) return this.fail();
    try {
      if (this.captureType === 'moov') {
        this.moovInfo = readMoov(buf, box);
        if (!this.moovInfo) return this.fail();
        if (this.moovInfo.headerDurationMs !== undefined) {
          this.result = this.moovInfo.headerDurationMs;
          return this.stop();
        }
        // No header duration and no fragments to sum: nothing more to learn.
        if (!this.moovInfo.fragmented) return this.stop();
      } else if (!addMoof(buf, box, this.fragments)) {
        return this.fail();
      }
    } catch {
      return this.fail();
    }
  }

  private fail(): void {
    this.broken = true;
    this.stop();
  }

  private stop(): void {
    this.stopped = true;
    this.capture = undefined;
  }

  /**
   * After {@link finish}: how far into the file the latest-starting track's
   * first sample lies, relative to the earliest track's, in ms (issue #577).
   * Read from the fragments only, so undefined for a file whose header carries
   * the duration (the scan stops at `moov`), a non-fragmented or unreadable
   * file, or one in which no track's first fragment was seen.
   */
  trackStartOffsetMs(): number | undefined {
    if (this.broken || !this.moovInfo?.fragmented) return undefined;
    return trackStartOffsetMs(this.moovInfo, this.fragments);
  }

  /** Duration in milliseconds, or undefined when it could not be read. */
  finish(): number | undefined {
    // The stream ended inside a captured box: truncated.
    if (this.capture) this.broken = true;
    this.capture = undefined;
    if (this.result !== undefined) return this.result;
    if (this.broken || !this.moovInfo?.fragmented) return undefined;
    return fragmentDurationMs(this.moovInfo, this.fragments);
  }
}
