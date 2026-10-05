/**
 * In-memory, per-source WHIP live-ingest state (issue #439, parent #437).
 *
 * Gives controllers a signal for which WHIP sources are actually sending,
 * WITHOUT waiting on an upstream Strom change. The state is driven entirely by
 * this backend's own WHIP signaling proxy (`src/routes/whip.ts`):
 *   - a source is marked `connected` when its WHIP offer POST succeeds, and
 *   - `disconnected` when the WHIP session DELETE (teardown) is called.
 *
 * KNOWN INTERIM LIMITATION (by design — see #439): this only observes the
 * proxy's own offer/teardown traffic, so a publisher that drops WITHOUT sending
 * a DELETE (closed tab, network loss, crash) stays `connected` forever. The
 * robust version keys off real Strom session events (incl. ICE-failure / idle
 * cleanup) and is tracked as a sibling issue needing an upstream Strom change —
 * it is deliberately OUT OF SCOPE here.
 *
 * State lives only in process memory: it is NOT persisted and resets to empty
 * on server restart (a restart loses any in-flight publishers' state, same
 * trade-off as the HTML-source param registry in `src/ws/controller.ts`). It is
 * exposed read-only on source responses (`src/routes/sources.ts`) as a separate
 * field and must NEVER overwrite the client-writable `status` field.
 */

/** A WHIP source's observed live-ingest state. */
export type WhipIngestState = 'connected' | 'disconnected';

/** A per-source live-ingest snapshot: the state plus when it last changed. */
export interface WhipIngestSnapshot {
  state: WhipIngestState;
  /** ISO-8601 UTC timestamp of the last state transition. */
  changedAt: string;
}

/** sourceId -> current live-ingest snapshot. */
const stateBySource = new Map<string, WhipIngestSnapshot>();

/**
 * Record a source's live-ingest `state`. Returns `true` when this actually
 * changed the stored state (first observation, or a transition), so the caller
 * can broadcast only on a real change. A repeated same-state call (e.g. a second
 * DELETE, or a re-offer while already connected) refreshes `changedAt` but
 * returns `false`.
 */
export function setWhipIngestState(sourceId: string, state: WhipIngestState): boolean {
  const prev = stateBySource.get(sourceId);
  const changed = prev?.state !== state;
  stateBySource.set(sourceId, { state, changedAt: new Date().toISOString() });
  return changed;
}

/** Current live-ingest snapshot for a source, or `undefined` if never observed. */
export function getWhipIngestState(sourceId: string): WhipIngestSnapshot | undefined {
  return stateBySource.get(sourceId);
}

/** Test-only: drop a source's recorded state (or all state when no id given). */
export function clearWhipIngestState(sourceId?: string): void {
  if (sourceId === undefined) stateBySource.clear();
  else stateBySource.delete(sourceId);
}
