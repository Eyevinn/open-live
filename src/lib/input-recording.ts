/**
 * Per-input ("ISO") recording: recorders for an arriving feed, chosen per
 * source assignment (`ProductionSourceAssignment.record`). Off unless the
 * assignment opts in: a feed may already be recorded upstream, and in a
 * delayed production the mixer inputs are bridged out of the store.
 *
 * Each recorder taps its input before the time_offset blocks, so it holds the
 * feed as it arrived. The offset is a pad offset on running time
 * (Strom time_offset.rs); a live trim would jump the recording's timestamps,
 * and a smaller one would send them backwards into the muxer.
 */
import type { FlowTopology } from './default-flow.js';

export type { InputRecordMode } from '../db/types.js';

/** Strom media directory of one input's recordings, inside the activation's. */
export function inputRecordingsDir(activationDir: string, mixerInput: string): string {
  return `${activationDir}/${mixerInput}`;
}

/** Name of an input recording directory, as written by inputRecordingsDir. */
export const INPUT_RECORDING_DIR_RE = /^video_in_\d{1,2}$/;

/**
 * builtin.videoenc counts its GOP in frames. 60 is 2 s at the 30 fps browsers
 * send; a source running slower gets proportionally longer GOPs. SPS/PPS need
 * no setting: the block's h264parse repeats them every second
 * (videoenc.rs configure_parser), and the recorder's every keyframe.
 */
const KEYFRAME_INTERVAL_FRAMES = 60;
const VIDEO_BITRATE_KBPS = 4000;

/** What a production's input recorders can carry on this Strom. */
export interface InputRecordingSupport {
  video: boolean;
  audio: boolean;
}

export type InputTrack = 'video' | 'audio';

export interface InputRecorder {
  mixerInput: string;
  /** builtin.liverecorder block ID per recorded track */
  blockIds: Partial<Record<InputTrack, string>>;
  outputDir: string;
  recordMode: 'transcode';
}

export interface InputTap {
  mixerInput: string;
  padIndex: number;
  /** Decoded picture, before any time_offset */
  videoPad: string;
  /** Decoded sound, before any time_offset */
  audioPad: string;
}

/**
 * Adds transcoding recorders for one input: one per track, so each track has
 * a file of its own and an input that only ever sends one (an audio-only
 * guest, a camera with no sound) still records it.
 *
 * Each branch starts with a leaky queue: it gives the encoder its own thread,
 * so encoding never runs in the input's streaming thread, and if the recorder
 * backs up it drops frames instead of stalling the input's tee, which also
 * feeds the mixers.
 */
export function addTranscodingInputRecorder(
  flow: FlowTopology,
  tap: InputTap,
  opts: {
    productionId: string;
    activationDir: string;
    idSuffix: string;
    support: InputRecordingSupport;
    position: { x: number; y: number };
  },
): InputRecorder {
  const { padIndex, mixerInput } = tap;
  const { idSuffix, position } = opts;
  const outputDir = inputRecordingsDir(opts.activationDir, mixerInput);
  const leakyQueue = { leaky: 'downstream', 'max-size-buffers': 0, 'max-size-bytes': 0, 'max-size-time': 1_000_000_000 };
  const tracks = [
    {
      track: 'video' as const,
      pad: tap.videoPad,
      encoder: { block_definition_id: 'builtin.videoenc', properties: { codec: 'h264', bitrate: VIDEO_BITRATE_KBPS, keyframe_interval: KEYFRAME_INTERVAL_FRAMES } },
      encoderIn: 'video_in',
      recorderIn: 'video_in_0',
      trackCounts: { num_video_tracks: 1, num_audio_tracks: 0 },
    },
    {
      track: 'audio' as const,
      pad: tap.audioPad,
      encoder: { block_definition_id: 'builtin.audioenc', properties: { codec: 'aac' } },
      encoderIn: 'audio_in',
      recorderIn: 'audio_in_0',
      trackCounts: { num_video_tracks: 0, num_audio_tracks: 1 },
    },
  ];

  const blockIds: InputRecorder['blockIds'] = {};
  tracks.forEach(({ track, pad, encoder, encoderIn, recorderIn, trackCounts }, row) => {
    if (!opts.support[track]) return;
    const t = track[0];
    const queueId = `e-inrec-${t}q-${padIndex}-${idSuffix}`;
    const encId = `b-inrec-${t}enc-${padIndex}-${idSuffix}`;
    const recorderId = `b-inrec-${t}-${padIndex}-${idSuffix}`;
    const y = position.y + row * 60;
    flow.elements.push({ id: queueId, element_type: 'queue', properties: leakyQueue, position: [position.x, y] });
    flow.blocks.push({ id: encId, ...encoder, name: `Record ${mixerInput} ${track} encoder`, position: { x: position.x + 200, y } });
    flow.blocks.push({
      id: recorderId,
      block_definition_id: 'builtin.liverecorder',
      name: `Record ${mixerInput} ${track}`,
      properties: { output_dir: outputDir, filename_prefix: inputRecordingFilePrefix(opts.productionId, mixerInput, track), ...trackCounts },
      position: { x: position.x + 400, y },
    });
    flow.links.push(
      { from: pad, to: `${queueId}:sink` },
      { from: `${queueId}:src`, to: `${encId}:${encoderIn}` },
      { from: `${encId}:encoded_out`, to: `${recorderId}:${recorderIn}` },
    );
    blockIds[track] = recorderId;
  });

  return { mixerInput, blockIds, outputDir, recordMode: 'transcode' };
}

/** Recorder filename_prefix of one input track; files are `<prefix>_<timestamp>_<n>.mp4`. */
export function inputRecordingFilePrefix(productionId: string, mixerInput: string, track: InputTrack): string {
  return `${productionId}_${mixerInput}_${track}`;
}
