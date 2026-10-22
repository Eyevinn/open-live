import { createHash } from 'crypto';
import type { RecordingDoc } from '../db/types.js';

/**
 * Registers uploaded recordings idempotently (issue #554, OL-31c).
 *
 * A file whose Strom delete failed after upload is swept, uploaded and
 * registered again by the next deactivate. With a random `_id` that left two
 * `RecordingDoc`s for one object; deriving the id from bucket+key makes the
 * second registration update the first instead.
 *
 * Kept outside `src/db/index.ts` on purpose: many tests replace that module
 * wholesale with `vi.mock`.
 */

/**
 * Deterministic `RecordingDoc` id for an object. Hashed because keys contain
 * `/` and arbitrary characters; the NUL separator keeps `("a/b", "c")` and
 * `("a", "b/c")` distinct.
 */
export function recordingDocId(bucket: string, key: string): string {
  return `recording-${createHash('sha256').update(`${bucket}\0${key}`).digest('hex').slice(0, 32)}`;
}

/** The slice of the recordings DB scope the upsert needs. */
export interface RecordingDocStore {
  get(id: string): Promise<RecordingDoc>;
  insert(doc: RecordingDoc): Promise<unknown>;
}

const MAX_UPSERT_ATTEMPTS = 3;

function isConflict(err: unknown): boolean {
  return (err as { statusCode?: number } | null)?.statusCode === 409;
}

/**
 * Inserts `doc` under {@link recordingDocId}, or overwrites the existing doc
 * for the same bucket+key. An overwrite keeps the original `createdAt`; every
 * other field comes from `doc`, the latest upload. Retries on a 409 from a
 * concurrent writer; any other error is thrown.
 */
export async function upsertRecordingDoc(
  store: RecordingDocStore,
  doc: Omit<RecordingDoc, '_id' | '_rev'>,
): Promise<RecordingDoc> {
  const _id = recordingDocId(doc.bucket, doc.key);
  const fresh: RecordingDoc = { ...doc, _id };
  try {
    await store.insert(fresh);
    return fresh;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  for (let attempt = 1; ; attempt++) {
    const existing = await store.get(_id);
    const updated: RecordingDoc = { ...fresh, _rev: existing._rev, createdAt: existing.createdAt };
    try {
      await store.insert(updated);
      return updated;
    } catch (err) {
      if (!isConflict(err) || attempt >= MAX_UPSERT_ATTEMPTS) throw err;
    }
  }
}
