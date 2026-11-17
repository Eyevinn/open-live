/**
 * Read-time audio-stream discovery for a source (ADR-006 Decision 3, issue #631).
 *
 * Strom has no per-input PMT probe, but a running flow reports the negotiated
 * caps of every pad through `GET /api/flows/{id}/pad-caps`
 * (`{ [elementName]: [{ pad, direction, caps }] }`, caps `"NOT NEGOTIATED"`
 * until the pad has data). An SRT source's `builtin.mpegtssrt_input` block
 * decodes through a `decodebin` element named `<blockId>:decodebin`; its
 * `src_N` pads carry one decoded elementary stream each. The `audio/` ones,
 * ordered by N, are the feed's audio streams in ascending PID order — the
 * order `map_audio_by_pid` ranks by, so discovered `index` k is the stream
 * `audioStreamIndex = k` selects. decodebin2 sorts its end pads before naming
 * them (`gstdecodebin2.c` `sort_end_pads`: by media class, then by stream-id),
 * and tsdemux stream-ids end in the PID as `%08x`, so within the audio class
 * stream-id order is PID order (Strom v0.8.3
 * `mpegtssrt_input/audio_by_pid.rs:411` relies on the same fact). Decoded caps
 * carry the channel count but not the codec or language, so those are left out.
 *
 * Discovery only works while the source is in an active production: there is
 * no flow to read otherwise.
 */

import type { ProductionDoc, SourceDoc } from '../db/types.js';
import { StromClientError } from '../lib/strom.js';

export interface DiscoveredAudioStream {
  /** 0-based audio-stream index, the same numbering as `audioStreamIndex`. */
  index: number;
  /** Channel count from the decoded caps; absent when the caps do not state it. */
  channels?: number;
}

export type AudioStreamUnavailableReason =
  /** The source is not in an active production, or that production has no Strom flow. */
  | 'no-live-flow'
  /** Only `srt` (MPEG-TS) sources can be discovered. */
  | 'stream-type-unsupported'
  /** The flow is not running, or no audio stream has been negotiated on the input yet. */
  | 'no-signal'
  /** Strom could not be reached or refused the request. */
  | 'strom-unreachable';

export type AudioStreamDiscoveryResult =
  | { discovery: 'available'; streams: DiscoveredAudioStream[] }
  | { discovery: 'unavailable'; reason: AudioStreamUnavailableReason; streams: null };

/** The part of the Strom client discovery needs. */
export interface PadCapsReader {
  flows: { padCaps: (flowId: string, timeoutMs?: number) => Promise<Record<string, unknown>> };
}

/** How long one pad-caps read may take before Strom counts as unreachable. */
const PAD_CAPS_TIMEOUT_MS = 5000;

/**
 * The `mpegtssrt_input` block ids the flow generator builds for a source in a
 * production: `b-input-<padIndex>-<endpointSuffix>` per assignment
 * (`src/lib/flow-generator.ts`). A source assigned to several inputs has
 * several blocks.
 */
export function inputBlockIdsForSource(doc: Pick<ProductionDoc, '_id' | 'sources'>, sourceId: string): string[] {
  const endpointSuffix = doc._id.replace(/^prod-/, '').slice(0, 8);
  const ids: string[] = [];
  for (const assignment of doc.sources ?? []) {
    if (assignment.sourceId !== sourceId) continue;
    const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
    if (!padMatch) continue;
    ids.push(`b-input-${parseInt(padMatch[1], 10)}-${endpointSuffix}`);
  }
  return ids;
}

/**
 * The audio streams of one input block from a pad-caps response: the
 * `<blockId>:decodebin` element's negotiated `src_N` pads whose caps start
 * with `audio/`, ordered by N.
 */
export function audioStreamsFromPadCaps(padCaps: unknown, blockId: string): DiscoveredAudioStream[] {
  if (!padCaps || typeof padCaps !== 'object') return [];
  const pads = (padCaps as Record<string, unknown>)[`${blockId}:decodebin`];
  if (!Array.isArray(pads)) return [];
  const audio: Array<{ n: number; caps: string }> = [];
  for (const entry of pads) {
    if (!entry || typeof entry !== 'object') continue;
    const { pad, direction, caps } = entry as { pad?: unknown; direction?: unknown; caps?: unknown };
    if (typeof pad !== 'string' || typeof caps !== 'string') continue;
    if (direction !== undefined && direction !== 'src') continue;
    const m = /^src_(\d+)$/.exec(pad);
    if (!m || !caps.startsWith('audio/')) continue;
    audio.push({ n: parseInt(m[1], 10), caps });
  }
  audio.sort((a, b) => a.n - b.n);
  return audio.map(({ caps }, index) => {
    const ch = /(?:^|[,\s])channels=(?:\(int\))?(\d+)/.exec(caps);
    return ch ? { index, channels: parseInt(ch[1], 10) } : { index };
  });
}

/**
 * Discover a source's audio streams from the live flows of the active
 * productions it is assigned in. `productions` are those productions (any
 * without a `stromFlowId` are skipped); `strom` is only called when there is a
 * flow to read.
 */
export async function discoverAudioStreams(
  source: Pick<SourceDoc, '_id' | 'streamType'>,
  productions: ReadonlyArray<Pick<ProductionDoc, '_id' | 'sources' | 'stromFlowId'>>,
  strom: () => Promise<PadCapsReader>,
): Promise<AudioStreamDiscoveryResult> {
  if (source.streamType !== 'srt') {
    return { discovery: 'unavailable', reason: 'stream-type-unsupported', streams: null };
  }
  const flows = productions
    .filter((p): p is typeof p & { stromFlowId: string } => typeof p.stromFlowId === 'string' && p.stromFlowId.length > 0)
    .map((p) => ({ flowId: p.stromFlowId, blockIds: inputBlockIdsForSource(p, source._id) }))
    .filter((f) => f.blockIds.length > 0);
  if (flows.length === 0) {
    return { discovery: 'unavailable', reason: 'no-live-flow', streams: null };
  }

  const client = await strom();
  let reachedStrom = false;
  for (const { flowId, blockIds } of flows) {
    let padCaps: Record<string, unknown>;
    try {
      padCaps = await client.flows.padCaps(flowId, PAD_CAPS_TIMEOUT_MS);
    } catch (err: unknown) {
      // 404 = Strom answered, but the flow is not running ("Flow not running").
      // Anything else (network error, timeout, 401/5xx) leaves Strom unreached.
      if (err instanceof StromClientError && err.status === 404) reachedStrom = true;
      continue;
    }
    reachedStrom = true;
    for (const blockId of blockIds) {
      const streams = audioStreamsFromPadCaps(padCaps, blockId);
      if (streams.length > 0) return { discovery: 'available', streams };
    }
  }
  return { discovery: 'unavailable', reason: reachedStrom ? 'no-signal' : 'strom-unreachable', streams: null };
}
