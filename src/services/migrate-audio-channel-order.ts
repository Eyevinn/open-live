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
 * Idempotent and race-safe on two levels:
 *   - Instance-wide marker doc (`MIGRATION_ID`): a fast-path short-circuit so a
 *     fully-completed migration never scans again. This is also what keeps
 *     productions created AFTER the migration (already in the new numbering) from
 *     ever being remapped — they are created after the marker, so never scanned.
 *   - Per-production stamp (`ProductionDoc.audioChannelOrderV2`): written in the
 *     SAME insert that renumbers a doc's keys. The remap is a bijection over the
 *     moving channels, so applying it twice is NOT the identity (e.g. the 3-cycle
 *     {3:5,4:3,5:4} applied twice permutes again). If a single write fails
 *     mid-pass we return WITHOUT the instance marker and the next start re-runs —
 *     so the per-doc stamp is what makes that retry re-process only the
 *     un-migrated remainder instead of double-applying the remap to docs already
 *     renumbered on the previous pass.
 *
 * It runs at startup BEFORE the server accepts requests (like
 * `reconcileProductionStatuses`), so no production is created mid-pass.
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
  // Scan the FULL production set: Mango caps an unbounded find() at 25 docs, so
  // page through with an explicit limit until a short page ends the set. The
  // instance marker is only written once this whole scan + migrate loop finishes.
  const PAGE_LIMIT = 200;
  const productions: ProductionDoc[] = [];
  try {
    let bookmark: string | undefined;
    for (;;) {
      const page = await db.find({ selector: { type: 'production' }, limit: PAGE_LIMIT, bookmark });
      productions.push(...(page.docs as ProductionDoc[]));
      bookmark = page.bookmark;
      if (page.docs.length < PAGE_LIMIT) break;
    }
  } catch (err) {
    log.warn({ err }, '[migrate:audio-channel-order] CouchDB unreachable — skipping (will retry next start)');
    return;
  }

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
    // Per-doc idempotency: a doc stamped on a previous (possibly partial) pass is
    // already renumbered. Re-applying the bijective remap would double-permute it,
    // so skip it — the instance marker alone cannot protect a retry after a
    // mid-loop write failure, which is exactly when this stamp matters.
    if (doc.audioChannelOrderV2) continue;
    const values = doc.values;
    if (!values || Object.keys(values).length === 0) continue;
    for (const { sourceId } of doc.sources ?? []) await resolveSource(sourceId);
    const remap = audioChannelRenumberMap(doc.sources ?? [], (id) => (resolvable.has(id) ? id : undefined));
    const nextValues = remapAuxPreValues(values, remap);
    if (!nextValues) continue;
    try {
      // Stamp the per-doc flag in the SAME write that renumbers the keys, so a
      // retry after a later write fails will skip THIS doc and re-process only the
      // un-migrated remainder — never re-applying the remap to an already-moved doc.
      await db.insert({ ...doc, values: nextValues, audioChannelOrderV2: true, updatedAt: new Date().toISOString() });
      migratedCount++;
      log.info({ productionId: doc._id }, '[migrate:audio-channel-order] Renumbered persisted aux pre/post settings');
    } catch (err) {
      // A failed write leaves the instance marker unwritten so the pass retries on
      // next start; already-stamped docs above are skipped, so the retry re-processes
      // only the remainder instead of double-applying the remap.
      log.error({ err, productionId: doc._id }, '[migrate:audio-channel-order] Failed to migrate production');
      return;
    }
  }

  // The full production set has now been scanned and migrated. Record completion so
  // later restarts short-circuit the pass (and never re-migrate productions created
  // afterwards, which are already in the new numbering). Reached only after every
  // page was processed without a write failure.
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
