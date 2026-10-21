import { getSourcesDb } from '../db/index.js';
import type { ProductionDoc, SourceDoc } from '../db/types.js';
import { VIRTUAL_SOURCES } from './audio-channels.js';

/**
 * Commentator preview (`docs/specs/guest-calling-intercom.md`
 * §"Commentator preview").
 *
 * Operators may delay sources with their time_offset blocks to bring remote
 * commentary and picture into sync, which delays every program-derived WHEP
 * output too. A source assignment marked `commentatorPreview: true` gets an
 * extra WHEP output fed straight from its input block (video + the source's
 * own audio), before the offsets and outside the mixer, so a commentator can
 * watch the source undelayed. The Strom URL is persisted on the production as
 * `previewWhepUrls` at activation and is only ever used server-side.
 */

/**
 * Source kinds that can carry a commentator preview: those whose input is a
 * Strom BLOCK with raw `video_out` / audio pads that already fan out to the
 * offset blocks (SRT/EFP inputs, the clip media player). WHIP inputs are
 * guests/contributors rather than sources a commentator previews; HTML and
 * test-pattern inputs expose their raw pads on bare GStreamer elements
 * (cefdemux, audiotestsrc), so they are left out.
 */
export const PREVIEW_STREAM_TYPES: ReadonlySet<string> = new Set(['srt', 'efp', 'clip']);

/**
 * Resolve the internal Strom WHEP URL of a production's commentator preview on
 * a mixerInput, as persisted at activation. Teardown uses this directly; to
 * START viewing use `previewTarget`, which also requires the flag.
 */
export function previewStromUrl(doc: ProductionDoc, mixerInput: string): string | undefined {
  return (doc.previewWhepUrls ?? []).find((p) => p.mixerInput === mixerInput)?.url;
}

/**
 * The Strom WHEP target a viewer may start a commentator preview on: the
 * persisted preview URL, but only while the assignment is still marked
 * `commentatorPreview` — an operator unmarking a source revokes viewing at
 * once, even though the output stays in the running flow until the next
 * activation.
 */
export function previewTarget(doc: ProductionDoc, mixerInput: string): string | undefined {
  const assignment = doc.sources.find((s) => s.mixerInput === mixerInput);
  return assignment?.commentatorPreview ? previewStromUrl(doc, mixerInput) : undefined;
}

/**
 * The commentator previews a guest of `production` may watch, as advertised on
 * the guest join / slot responses: one entry per live preview, its `url` the
 * guest-scoped WHEP alias under `/api/v1/guests/:inviteId/...` (the crew path
 * is unreachable from a guest page on OSC, see guests.ts). Empty unless the
 * production is active. `label` is the source's display name, falling back to
 * the mixerInput when the source cannot be read.
 */
export async function guestPreviewFeeds(
  production: ProductionDoc,
  base: string,
  inviteId: string,
): Promise<Array<{ mixerInput: string; label: string; url: string }>> {
  if (production.status !== 'active' || !production.stromFlowId) return [];
  const previews = (production.previewWhepUrls ?? []).filter((p) => previewTarget(production, p.mixerInput));
  return Promise.all(
    previews.map(async ({ mixerInput }) => {
      const sourceId = production.sources.find((s) => s.mixerInput === mixerInput)?.sourceId;
      let label: string | undefined;
      if (sourceId) {
        label = VIRTUAL_SOURCES[sourceId]?.name;
        if (!label) {
          try {
            label = ((await getSourcesDb().get(sourceId)) as unknown as SourceDoc).name;
          } catch {
            // Source unreadable — fall back to the mixerInput below.
          }
        }
      }
      return {
        mixerInput,
        label: label || mixerInput,
        url: `${base}/api/v1/guests/${inviteId}/previews/${encodeURIComponent(mixerInput)}/whep`,
      };
    }),
  );
}
