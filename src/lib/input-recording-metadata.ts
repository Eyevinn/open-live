/**
 * Input recording metadata that needs the database (OL-32, spec
 * iso-input-recording.md §3.1): the guests of a WHIP input part. Kept apart
 * from `input-recording.ts` so the flow generator does not import the guest
 * collections.
 */
import { getGuestInvitesDb, getGuestSessionsDb } from '../db/index.js';
import type { ActiveInputRecording, RecordingDoc, RecordingGuest } from '../db/types.js';

/**
 * The guest sessions on a WHIP input that overlap `[startedAt, endedAt]` (spec
 * §3.1): joined at the session's `createdAt`, left at its `updatedAt` once it is
 * `left`, labelled from its invite. Best-effort: any database failure returns
 * no guests rather than failing the registration.
 */
export async function guestsForRecording(
  productionId: string,
  mixerInput: string,
  startedAt: string,
  endedAt: string,
): Promise<RecordingGuest[]> {
  try {
    const result = await getGuestSessionsDb().find({
      selector: { type: 'guest-session', productionId, mixerInput },
      limit: 200,
    });
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(endedAt);
    const overlapping = result.docs
      .map((s) => ({
        inviteId: s.inviteId,
        joinedAt: s.createdAt,
        ...(s.state === 'left' ? { leftAt: s.updatedAt } : {}),
      }))
      .filter((g) => {
        const joined = Date.parse(g.joinedAt);
        const left = g.leftAt !== undefined ? Date.parse(g.leftAt) : Number.POSITIVE_INFINITY;
        return !(joined > endMs) && !(left < startMs);
      })
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
    const labels = new Map<string, string | undefined>();
    const guests: RecordingGuest[] = [];
    for (const g of overlapping) {
      if (!labels.has(g.inviteId)) {
        const label = await getGuestInvitesDb().get(g.inviteId).then((i) => i.label, () => undefined);
        labels.set(g.inviteId, label);
      }
      const label = labels.get(g.inviteId);
      guests.push({ ...g, ...(label ? { label } : {}) });
    }
    return guests;
  } catch {
    return [];
  }
}

/**
 * The input metadata of an input part's `RecordingDoc` (spec §3.1). `input` is
 * the activation's entry for this mixer input when the part is this
 * activation's; a leftover of an earlier activation only knows its mixer input.
 */
export async function inputRecordingFields(
  productionId: string,
  mixerInput: string,
  input: Pick<ActiveInputRecording, 'sourceId' | 'sourceName' | 'streamType'> | undefined,
  span: { startedAt: string; endedAt: string },
): Promise<Pick<RecordingDoc, 'kind' | 'mixerInput' | 'sourceId' | 'sourceName' | 'streamType' | 'guests' | 'guestLabel'>> {
  const fields: Pick<RecordingDoc, 'kind' | 'mixerInput' | 'sourceId' | 'sourceName' | 'streamType' | 'guests' | 'guestLabel'> = {
    kind: 'input',
    mixerInput,
    ...(input ? { sourceId: input.sourceId, sourceName: input.sourceName, streamType: input.streamType } : {}),
  };
  if (input?.streamType === 'whip') {
    const guests = await guestsForRecording(productionId, mixerInput, span.startedAt, span.endedAt);
    if (guests.length > 0) {
      fields.guests = guests;
      const labelled = guests.find((g) => g.label);
      if (labelled?.label) fields.guestLabel = labelled.label;
    }
  }
  return fields;
}
