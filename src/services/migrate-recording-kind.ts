import type { FastifyBaseLogger } from 'fastify';
import { getRecordingsDb, getMigrationStateDb, isDbConnected } from '../db/index.js';
import type { RecordingDoc, MigrationStateDoc } from '../db/types.js';

/**
 * One-time migration for OL-32a (spec iso-input-recording.md §3.4): every
 * `RecordingDoc` written before `kind` existed is a program recording, so set
 * `kind: 'program'` on each doc that has none. Readers already treat a missing
 * `kind` as `program`, so the listing is right before this finishes except for
 * an explicit `kind=program` filter.
 *
 * Same `MigrationStateDoc` pattern as `migrate-audio-channel-order.ts`:
 *   - Instance-wide marker (`migration:recording-kind-v1`): once written, later
 *     starts skip the scan.
 *   - Per doc: the selector only matches docs without `kind`, and setting it is
 *     idempotent, so a run interrupted by a failed write simply resumes with the
 *     remainder on the next start (no marker is written until a pass finds no
 *     doc left to change).
 *
 * The selector is a literal with `$exists`, so it goes through `findTrusted`
 * (no request data, #257). Runs at startup before the server accepts requests.
 */
export const MIGRATION_ID = 'recording-kind-v1';
const MIGRATION_DOC_ID = `migration:${MIGRATION_ID}`;
const PAGE_LIMIT = 200;

function hasStatus(err: unknown, status: number): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === status;
}

export async function migrateRecordingKind(log: FastifyBaseLogger): Promise<void> {
  if (!isDbConnected()) {
    log.debug('[migrate:recording-kind] Database not connected — skipping');
    return;
  }
  const migrations = getMigrationStateDb();
  try {
    await migrations.get(MIGRATION_DOC_ID);
    log.debug('[migrate:recording-kind] Already applied — skipping');
    return;
  } catch (err) {
    if (!hasStatus(err, 404)) throw err;
  }

  const db = getRecordingsDb();
  let migratedCount = 0;
  // Every updated doc drops out of the selector, so each page is a fresh
  // query from the start; the loop ends on an empty page. A page that changes
  // nothing (should not happen) ends it too rather than spinning.
  for (;;) {
    let docs: RecordingDoc[];
    try {
      const page = await db.findTrusted({
        selector: { type: 'recording', kind: { $exists: false } },
        limit: PAGE_LIMIT,
      });
      docs = page.docs as RecordingDoc[];
    } catch (err) {
      log.warn({ err }, '[migrate:recording-kind] CouchDB unreachable — skipping (will retry next start)');
      return;
    }
    if (docs.length === 0) break;
    let changed = 0;
    for (const doc of docs) {
      if (doc.kind) continue;
      try {
        await db.insert({ ...doc, kind: 'program' });
        changed++;
        migratedCount++;
      } catch (err) {
        log.error({ err, recordingId: doc._id }, '[migrate:recording-kind] Failed to migrate recording — will resume next start');
        return;
      }
    }
    if (changed === 0) break;
  }

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
  log.info({ migratedCount }, '[migrate:recording-kind] Migration complete');
}
