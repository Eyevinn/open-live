import Nano from 'nano';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import type { ProductionDoc, SourceDoc, ProductionConfigDoc, GraphicDoc, OutputDoc, GatewayDoc, RecordingDoc, GuestInviteDoc, GuestSessionDoc, GuestSigningKeyDoc, CredentialEncryptionKeyDoc, RtmpCredentialKeyDoc, MigrationStateDoc, GpuUsageLedgerDoc, GpuMeteringStateDoc, StorageConnectionDoc, IntercomConnectionDoc } from './types.js';


let db: Nano.DocumentScope<ProductionDoc>;

/**
 * Mango-injection guard for CouchDB `find()` selectors. CouchDB treats any
 * object key beginning with `$` as a query operator (`$in`, `$or`, `$regex`,
 * `$gt`, …). If user-supplied input is ever merged into a selector without
 * sanitising, an attacker could smuggle operators to widen a query, trigger an
 * expensive `$regex`, or bypass an intended `{ type: '...' }` predicate
 * (OWASP A03 — Injection).
 *
 * This guard walks a selector recursively and throws on any `$`-prefixed key.
 * It is wired onto the `find()` hot path (see `withTypeGuard`) so that any
 * endpoint forwarding user input to `db.find()` is protected by default (#64).
 *
 * Injection risk comes from a selector's *provenance*, not from whether it
 * contains operators: `{ status: { $in: [...] } }` written as a literal here is
 * harmless, while `{ name: req.query.name }` is dangerous even with no `$` in
 * the source, because the value may itself carry operators. Application code
 * that legitimately needs Mango operators therefore calls `findTrusted()`
 * instead — see the note there (#257).
 */
export class MangoInjectionError extends Error {
  constructor(key: string) {
    super(`Unsafe Mango operator '${key}' in find() selector`);
    this.name = 'MangoInjectionError';
  }
}

export function safeSelector<T>(selector: T): T {
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key.startsWith('$')) {
          throw new MangoInjectionError(key);
        }
        walk(child);
      }
    }
  };
  walk(selector);
  return selector;
}

/**
 * A `DocumentScope` with the Mango-injection guard wired onto `find()`, plus a
 * `findTrusted()` escape hatch for selectors written as literals in application
 * code (#257).
 */
export interface GuardedScope<T> extends Nano.DocumentScope<T> {
  findTrusted: (query: Nano.MangoQuery) => Promise<Nano.MangoResponse<T>>;
}

// All document types share one physical CouchDB database and one nano handle,
// which is re-typed per collection via `as unknown as ...`. There is no
// database-level isolation, so a wrong-collection read (e.g. fetching a
// `src-` doc through the productions handle) would otherwise return a
// mismatched document silently. `withTypeGuard` wraps `.get()` to assert the
// returned document's discriminator matches the collection it was fetched
// from. It only throws on a genuine cross-type mismatch — documents with no
// `type` field (legacy) are tolerated so existing data keeps working.
// Exported for tests, which exercise the guard through the proxy rather than
// calling safeSelector() directly — that is where the find/findTrusted split
// actually lives.
export function withTypeGuard<T extends { type?: string }>(
  scope: Nano.DocumentScope<T>,
  expectedType: T extends { type: infer U } ? U : string,
): GuardedScope<T> {
  const boundGet = scope.get.bind(scope) as (...args: unknown[]) => Promise<T>;
  const boundFind = scope.find.bind(scope) as (...args: unknown[]) => Promise<unknown>;
  return new Proxy(scope, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return async (...args: unknown[]): Promise<T> => {
          const doc = await boundGet(...args);
          const actualType = (doc as { type?: string }).type;
          if (actualType !== undefined && actualType !== expectedType) {
            throw new Error(
              `Document type mismatch: expected '${String(expectedType)}' but read '${actualType}' for id '${String(args[0])}'`,
            );
          }
          return doc;
        };
      }
      if (prop === 'find') {
        // Always run the Mango-injection guard on the selector before it reaches
        // CouchDB, so no future user-input-driven query can bypass it (#64).
        return (query: Nano.MangoQuery, ...rest: unknown[]): Promise<unknown> => {
          if (query && typeof query === 'object') {
            safeSelector(query.selector);
          }
          return boundFind(query, ...rest);
        };
      }
      if (prop === 'findTrusted') {
        // Skips the injection guard, for selectors written as literals in
        // application code that legitimately need Mango operators ($in,
        // $elemMatch, …).
        //
        // NEVER call this with a selector that contains, or is built from,
        // request data — use find() for anything user-derived. Every bypass is
        // visible via `grep -rn findTrusted src/`, which is the audit list.
        return (query: Nano.MangoQuery, ...rest: unknown[]): Promise<unknown> =>
          boundFind(query, ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as GuardedScope<T>;
}

export function getDb(): GuardedScope<ProductionDoc> {
  return withTypeGuard(db, 'production');
}

export function isDbConnected(): boolean {
  return !!db;
}

export function getSourcesDb(): GuardedScope<SourceDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<SourceDoc>, 'source');
}

export function getConfigsDb(): GuardedScope<ProductionConfigDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<ProductionConfigDoc>, 'production-config');
}

export function getGraphicsDb(): GuardedScope<GraphicDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GraphicDoc>, 'graphic');
}

export function getOutputsDb(): GuardedScope<OutputDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<OutputDoc>, 'output');
}

export function getGatewaysDb(): GuardedScope<GatewayDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GatewayDoc>, 'gateway');
}

export function getRecordingsDb(): GuardedScope<RecordingDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<RecordingDoc>, 'recording');
}

export function getGuestInvitesDb(): GuardedScope<GuestInviteDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GuestInviteDoc>, 'guest-invite');
}

export function getGuestSessionsDb(): GuardedScope<GuestSessionDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GuestSessionDoc>, 'guest-session');
}

export function getGuestSigningKeysDb(): GuardedScope<GuestSigningKeyDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GuestSigningKeyDoc>, 'guest-signing-key');
}

export function getCredentialEncryptionKeysDb(): GuardedScope<CredentialEncryptionKeyDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<CredentialEncryptionKeyDoc>, 'credential-encryption-key');
}

export function getRtmpCredentialKeysDb(): GuardedScope<RtmpCredentialKeyDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<RtmpCredentialKeyDoc>, 'rtmp-credentials-key');
}

export function getMigrationStateDb(): GuardedScope<MigrationStateDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<MigrationStateDoc>, 'migration-state');
}

export function getGpuUsageLedgerDb(): GuardedScope<GpuUsageLedgerDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GpuUsageLedgerDoc>, 'gpu-usage-ledger');
}

export function getGpuMeteringStateDb(): GuardedScope<GpuMeteringStateDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GpuMeteringStateDoc>, 'gpu-metering-state');
}

export function getStorageConnectionsDb(): GuardedScope<StorageConnectionDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<StorageConnectionDoc>, 'storage-connection');
}

export function getIntercomConnectionDb(): GuardedScope<IntercomConnectionDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<IntercomConnectionDoc>, 'intercom-connection');
}

/** The database every instance used before `COUCHDB_NAME` was honoured (OL-49). */
const LEGACY_DB_NAME = 'open-live';

/**
 * Marker document written into the configured database when an instance
 * settles on it while it is still empty (OL-49). A configured database that
 * holds any document is never given up for `open-live`, so this keeps a new
 * instance on its own database once it has started there, and an operator can
 * write it to claim a pre-created database (see README, `COUCHDB_NAME`).
 */
export const DATABASE_MARKER_DOC_ID = 'open-live-database';

/**
 * Documents every instance writes for itself on start, whether or not anyone
 * has used it: the key bootstraps, the GPU-metering marker, migration state and
 * the database marker. They are not "data" when deciding whether `open-live`
 * holds an existing instance's productions, sources and settings. Literal ids,
 * not imports, because those modules import this one (a test checks they match).
 */
export const BOOKKEEPING_DOC_IDS: ReadonlySet<string> = new Set([
  'guest-invite-signing-key',
  'credential-encryption-key',
  'rtmp-credentials-key',
  'gpu-metering-state',
  DATABASE_MARKER_DOC_ID,
]);

function isDesignDoc(id: string): boolean {
  return id.startsWith('_design/');
}

/** A document that holds an instance's data, not per-instance bookkeeping. */
export function isDataDocId(id: string): boolean {
  return !isDesignDoc(id) && !id.startsWith('migration:') && !BOOKKEEPING_DOC_IDS.has(id);
}

const ID_PAGE_SIZE = 100;

/** True when the database has a document whose id satisfies `match` (ids only, paged). */
async function hasDocMatching(nano: Nano.ServerScope, name: string, match: (id: string) => boolean): Promise<boolean> {
  const scope = nano.use(name);
  let startkey: string | undefined;
  for (;;) {
    const page = await scope.list(
      startkey === undefined ? { limit: ID_PAGE_SIZE } : { limit: ID_PAGE_SIZE, startkey, skip: 1 },
    );
    if (page.rows.some((row) => match(row.id))) return true;
    if (page.rows.length < ID_PAGE_SIZE) return false;
    startkey = page.rows[page.rows.length - 1]!.id;
  }
}

/** The logger methods the database-name resolution uses (a Fastify logger fits). */
export type DbLog = Pick<FastifyBaseLogger, 'info' | 'warn'>;

/**
 * Pick the CouchDB database to use for the configured name (OL-49, issue #619),
 * creating it when needed:
 * - `open-live` configured: as before — use it, creating it if it is missing.
 * - configured database exists and holds any document (design docs aside): use it.
 * - configured database missing or empty, and `open-live` holds data (documents
 *   other than design docs and bookkeeping, see `isDataDocId`): use `open-live`
 *   and warn. The configured database is neither created nor written to, so an
 *   upgraded instance keeps its data and never later switches to an empty
 *   database. This covers an OSC instance whose `DatabaseUrl` path is not
 *   `open-live`, also when a database of that name was created empty
 *   beforehand (upgrade safety, #619 AC4).
 * - otherwise: create the configured database if missing, write the marker
 *   document so the instance stays on it, and use it.
 */
export async function resolveDbName(nano: Nano.ServerScope, configured: string, log?: DbLog): Promise<string> {
  const dbList = await nano.db.list();
  if (configured === LEGACY_DB_NAME) {
    if (!dbList.includes(configured)) {
      await nano.db.create(configured);
      log?.info(`[db] Created CouchDB database "${configured}"`);
    }
    return configured;
  }
  const configuredExists = dbList.includes(configured);
  if (configuredExists && (await hasDocMatching(nano, configured, (id) => !isDesignDoc(id)))) return configured;
  if (dbList.includes(LEGACY_DB_NAME) && (await hasDocMatching(nano, LEGACY_DB_NAME, isDataDocId))) {
    log?.warn(
      `[db] CouchDB database "${configured}" (COUCHDB_NAME) ${configuredExists ? 'is empty' : 'does not exist'}, ` +
        `but "${LEGACY_DB_NAME}" holds data — using "${LEGACY_DB_NAME}" so an upgraded instance keeps its data; ` +
        `"${configured}" was not ${configuredExists ? 'written to' : 'created'}. If this is a new instance on a shared ` +
        `CouchDB server, it is now sharing "${LEGACY_DB_NAME}" with another instance, and each one's startup reconcile, ` +
        `idle watchdog and sweeps will act on the other's productions. To give it its own database, create ` +
        `"${configured}" with the document "${DATABASE_MARKER_DOC_ID}" in it and restart.`,
    );
    return LEGACY_DB_NAME;
  }
  if (!configuredExists) {
    await nano.db.create(configured);
    log?.info(`[db] Created CouchDB database "${configured}"`);
  }
  try {
    await nano
      .use<{ type: string; createdAt: string }>(configured)
      .insert({ _id: DATABASE_MARKER_DOC_ID, type: 'database-marker', createdAt: new Date().toISOString() });
  } catch (err) {
    // Another instance or the operator wrote it first: the database is claimed either way.
    if ((err as { statusCode?: number })?.statusCode !== 409) throw err;
  }
  return configured;
}

export async function connectDb(log?: DbLog): Promise<void> {
  const nano = Nano({ url: config.couchdbUrl, requestDefaults: { timeout: 10_000 } });
  const dbName = await resolveDbName(nano, config.couchdbName, log);
  db = nano.use<ProductionDoc>(dbName);
  log?.info(`[db] Using CouchDB database "${dbName}"`);
}

export async function isDbReady(): Promise<boolean> {
  try {
    // Use the actual working db handle so we test the same path as real queries
    if (!db) return false;
    await db.info();
    return true;
  } catch {
    return false;
  }
}
