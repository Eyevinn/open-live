import type { ProductionSourceAssignment, SourceDoc } from '../db/types.js';
import { getSourcesDb } from '../db/index.js';

/** Source IDs that stand for built-in inputs and have no document in the sources DB. */
export const VIRTUAL_SOURCES: Record<string, Pick<SourceDoc, 'streamType' | 'address' | 'name'>> = {
  'Whip': { streamType: 'whip', address: '', name: 'WHIP Input' },
  '__test1__': { streamType: 'test1', address: '', name: 'Test - Pinwheel' },
  '__test2__': { streamType: 'test2', address: '', name: 'Test - Colors' },
};

export interface AudioChannel<S> {
  /** 0-based: the flow wires it to audio mixer `input_{channel + 1}` and the API calls it `ch{channel + 1}`. */
  channel: number;
  assignment: ProductionSourceAssignment;
  source: S;
}

/**
 * Numbers the audio mixer channels for a production's source assignments. The
 * flow generator wires channels with this numbering and everything that
 * addresses a channel by number must use it too.
 *
 * In mixerInput order, each assignment on a `video_in_N` pad whose source
 * resolves takes the next channel. Stream type never skips a channel: every
 * type carries audio, test patterns included (they get a silent branch).
 */
export function assignAudioChannels<S>(
  assignments: readonly ProductionSourceAssignment[],
  resolve: (sourceId: string) => S | undefined,
): AudioChannel<S>[] {
  const sorted = [...assignments].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const channels: AudioChannel<S>[] = [];
  for (const assignment of sorted) {
    if (!/video_in_\d+$/.test(assignment.mixerInput)) continue;
    const source = resolve(assignment.sourceId);
    if (!source) continue;
    channels.push({ channel: channels.length, assignment, source });
  }
  return channels;
}

/** Looks up each assigned source (virtual or in the sources DB), then numbers the channels. */
export async function loadAudioChannels(
  assignments: readonly ProductionSourceAssignment[],
): Promise<AudioChannel<Pick<SourceDoc, 'streamType' | 'name'>>[]> {
  const sourcesDb = getSourcesDb();
  const resolved = new Map<string, Pick<SourceDoc, 'streamType' | 'name'>>();
  for (const { sourceId } of assignments) {
    if (resolved.has(sourceId)) continue;
    const virtual = VIRTUAL_SOURCES[sourceId];
    if (virtual) {
      resolved.set(sourceId, virtual);
      continue;
    }
    try {
      resolved.set(sourceId, await sourcesDb.get(sourceId));
    } catch { /* missing source — no audio channel */ }
  }
  return assignAudioChannels(assignments, (id) => resolved.get(id));
}
