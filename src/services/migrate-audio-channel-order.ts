import type { FastifyBaseLogger } from 'fastify';
import { getDb, getSourcesDb, getMigrationStateDb, isDbConnected } from '../db/index.js';
import type { ProductionDoc, MigrationStateDoc } from '../db/types.js';
import { VIRTUAL_SOURCES, audioChannelRenumberMap } from '../lib/audio-channels.js';

/**
 * One-time migration for issue #487: the audio channel sort changed from lexical
 * (`localeCompare`) to numeric pad order so audio channels follow the picture.
 * For productions with a guest or 10+ sources that reorders the channel numbers,
 * and the per-channel pre/post settings persisted on the production doc
 * (`ch{N}_aux{M}_pre` in `values`, read by `flow-generator.ts` at build time)
 * are keyed by channel number — so without this migration a saved setting would
 * silently land on a DIFFERENT source after the upgrade.
 *
 * This remaps every persisted `ch{N}_aux{M}_pre` key from its OLD channel number
 * to the NEW one (computed from the production's own resolvable sources), so each
 * operator setting follows its source. The in-memory AUX send cache
 * (`auxSendByProduction` in `controller.ts`) is session state rebuilt from client
 * messages on every (re)connect, so it needs no migration — it is correct as soon
 * as clients reconnect against the renumbered flow.
 *
 * Idempotent and race-safe: it runs at most once per instance, gated on a single
 * marker doc (`MIGRATION_ID`). A per-production flag would not do — productions
 * created AFTER the migration are already in the new numbering, and re-running the
 * remap on them would corrupt them; the instance-wide marker avoids that. It runs
 * at startup BEFORE the server accepts requests (like `reconcileProductionStatuses`),
 * so no production is created mid-pass.
 */
export const MIGRATION_ID = 'audio-channel-order-v2';
const MIGRATION_DOC_ID = `migration:${MIGRATION_ID}`;

/** Only `ch{N}_aux{M}_pre` keys are channel-numbered persisted state (issue #487). */
const AUX_PRE_KEY = /^ch(\d+)_aux(\d+)_pre$/;

function hasStatus(err: unknown, status: number): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === status;
}

/**
 * Rewrites a production's `values`, moving each `ch{N}_aux{M}_pre` key whose
 * channel number changed to its new number. Returns a new values object, or
 * `null` when nothing changed. Builds the result in one pass so a bijective
 * remap (e.g. 3→5, 5→4, 4→3) never overwrites a sibling key mid-rename.
 */
export function remapAuxPreValues(
  values: Record<string, string | number | boolean>,
  remap: Map<number, number>,
): Record<string, string | number | boolean> | null {
  if (remap.size === 0) return null;
  const next: Record<string, string | number | boolean> = {};
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    const m = AUX_PRE_KEY.exec(key);
    const newChannel = m ? remap.get(parseInt(m[1], 10)) : undefined;
    if (m && newChannel !== undefined) {
      next[`ch${newChannel}_aux${m[2]}_pre`] = value;
      changed = true;
    } else {
      next[key] = value;
    }
  }
  return changed ? next : null;
}

export async function migrateAudioChannelOrder(log: FastifyBaseLogger): Promise<void> {
  if (!isDbConnected()) {
    log.debug('[migrate:audio-channel-order] Database not connected — skipping');
    return;
  }
  const migrations = getMigrationStateDb();

  // Already run on this instance — nothing to do.
  try {
    await migrations.get(MIGRATION_DOC_ID);
    log.debug('[migrate:audio-channel-order] Already applied — skipping');
    return;
  } catch (err) {
    if (!hasStatus(err, 404)) throw err;
  }

  const db = getDb();
  let result: Awaited<ReturnType<typeof db.find>>;
  try {
    result = await db.find({ selector: { type: 'production' } });
  } catch (err) {
    log.warn({ err }, '[migrate:audio-channel-order] CouchDB unreachable — skipping (will retry next start)');
    return;
  }
  const productions = result.docs as ProductionDoc[];

  // Resolve every referenced source once (virtual sources + sources DB), mirroring
  // loadAudioChannels, so the remap uses the SAME resolvable set the numbering does.
  const sourcesDb = getSourcesDb();
  const resolvable = new Set<string>();
  const unresolvable = new Set<string>();
  const resolveSource = async (sourceId: string): Promise<boolean> => {
    if (resolvable.has(sourceId)) return true;
    if (unresolvable.has(sourceId)) return false;
    if (VIRTUAL_SOURCES[sourceId]) { resolvable.add(sourceId); return true; }
    try {
      await sourcesDb.get(sourceId);
      resolvable.add(sourceId);
      return true;
    } catch {
      unresolvable.add(sourceId);
      return false;
    }
  };

  let migratedCount = 0;
  for (const doc of productions) {
    const values = doc.values;
    if (!values || Object.keys(values).length === 0) continue;
    for (const { sourceId } of doc.sources ?? []) await resolveSource(sourceId);
    const remap = audioChannelRenumberMap(doc.sources ?? [], (id) => (resolvable.has(id) ? id : undefined));
    const nextValues = remapAuxPreValues(values, remap);
    if (!nextValues) continue;
    try {
      await db.insert({ ...doc, values: nextValues, updatedAt: new Date().toISOString() });
      migratedCount++;
      log.info({ productionId: doc._id }, '[migrate:audio-channel-order] Renumbered persisted aux pre/post settings');
    } catch (err) {
      // Best-effort: a failed write leaves the marker unwritten so the whole pass
      // retries on next start (re-running the remap on an unchanged doc is safe).
      log.error({ err, productionId: doc._id }, '[migrate:audio-channel-order] Failed to migrate production');
      return;
    }
  }

  // Record completion so later restarts skip the pass (and never re-migrate
  // productions created afterwards, which are already in the new numbering).
  const marker: MigrationStateDoc = {
    _id: MIGRATION_DOC_ID,
    type: 'migration-state',
    migration: MIGRATION_ID,
    migratedCount,
    completedAt: new Date().toISOString(),
  };
  try {
    await migrations.insert(marker);
  } catch (err) {
    if (!hasStatus(err, 409)) throw err;
    // Lost the create race with another process — it finished the same pass.
  }
  log.info({ migratedCount }, '[migrate:audio-channel-order] Migration complete');
}
