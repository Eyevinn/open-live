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

/** Numeric suffix of a `video_in_N` pad id, or null when the id is not a pad. */
export function mixerInputPadIndex(mixerInput: string): number | null {
  const m = /video_in_(\d+)$/.exec(mixerInput);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Numbers the audio mixer channels for a production's source assignments. The
 * flow generator wires channels with this numbering and everything that
 * addresses a channel by number must use it too.
 *
 * Assignments are ordered by the NUMERIC pad index of their `mixerInput`, the
 * same ordering the video side uses to compact mixer pads (see `mixerInputMap`
 * in `flow-generator.ts`). A lexical `localeCompare` sort put `video_in_15`
 * before `video_in_2` and `video_in_10` before `video_in_2`, so for a
 * production with a guest (allocated from the top of the range down) or 10+
 * sources the audio channel order no longer followed the picture (issue #487).
 * Each assignment on a `video_in_N` pad whose source resolves takes the next
 * channel. Stream type never skips a channel: every type carries audio, test
 * patterns included (they get a silent branch).
 */
export function assignAudioChannels<S>(
  assignments: readonly ProductionSourceAssignment[],
  resolve: (sourceId: string) => S | undefined,
): AudioChannel<S>[] {
  const sorted = [...assignments]
    .filter((a) => mixerInputPadIndex(a.mixerInput) !== null)
    .sort((a, b) => mixerInputPadIndex(a.mixerInput)! - mixerInputPadIndex(b.mixerInput)!);
  const channels: AudioChannel<S>[] = [];
  for (const assignment of sorted) {
    const source = resolve(assignment.sourceId);
    if (!source) continue;
    channels.push({ channel: channels.length, assignment, source });
  }
  return channels;
}

/**
 * The 1-based channel renumbering caused by switching the audio channel sort
 * from lexical (`localeCompare`) to numeric pad order (issue #487). Returns a
 * map from OLD channel number → NEW channel number, computed from the SAME
 * resolvable `video_in_N` assignments `assignAudioChannels` would number (the
 * resolvable set does not depend on the sort, only the order does). Channels
 * whose number is unchanged are omitted, so the map is empty for any production
 * whose lexical and numeric orders already agree (every pad index < 10 with no
 * gaps-that-reorder). The map is a bijection over the channels that move, so it
 * can be applied to persisted per-channel keys without collisions.
 *
 * Used once to migrate persisted `ch{N}_aux{M}_pre` settings so a production's
 * per-channel pre/post choices follow their source into the new numbering
 * instead of silently landing on a different channel.
 */
export function audioChannelRenumberMap<S>(
  assignments: readonly ProductionSourceAssignment[],
  resolve: (sourceId: string) => S | undefined,
): Map<number, number> {
  const resolvable = assignments.filter(
    (a) => mixerInputPadIndex(a.mixerInput) !== null && resolve(a.sourceId) !== undefined,
  );
  const lexical = [...resolvable].sort((a, b) => a.mixerInput.localeCompare(b.mixerInput));
  const numeric = [...resolvable].sort(
    (a, b) => mixerInputPadIndex(a.mixerInput)! - mixerInputPadIndex(b.mixerInput)!,
  );
  const newChannelByInput = new Map<string, number>();
  numeric.forEach((a, i) => newChannelByInput.set(a.mixerInput, i + 1));
  const remap = new Map<number, number>();
  lexical.forEach((a, i) => {
    const oldChannel = i + 1;
    const newChannel = newChannelByInput.get(a.mixerInput)!;
    if (oldChannel !== newChannel) remap.set(oldChannel, newChannel);
  });
  return remap;
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
