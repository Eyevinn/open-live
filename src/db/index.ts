import Nano from 'nano';
import { config } from '../config.js';
import type { ProductionDoc, SourceDoc, ProductionConfigDoc, GraphicDoc, OutputDoc } from './types.js';


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
 * All current callers pass hardcoded, operator-free selectors (e.g.
 * `{ type: 'production' }`), so it is a no-op for them — but by wiring it onto
 * the `find()` hot path (see `withTypeGuard`) it becomes a real backstop for any
 * future endpoint that forwards user input to `db.find()` (#64).
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

// All document types share one physical CouchDB database and one nano handle,
// which is re-typed per collection via `as unknown as ...`. There is no
// database-level isolation, so a wrong-collection read (e.g. fetching a
// `src-` doc through the productions handle) would otherwise return a
// mismatched document silently. `withTypeGuard` wraps `.get()` to assert the
// returned document's discriminator matches the collection it was fetched
// from. It only throws on a genuine cross-type mismatch — documents with no
// `type` field (legacy) are tolerated so existing data keeps working.
function withTypeGuard<T extends { type?: string }>(
  scope: Nano.DocumentScope<T>,
  expectedType: T extends { type: infer U } ? U : string,
): Nano.DocumentScope<T> {
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
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function getDb(): Nano.DocumentScope<ProductionDoc> {
  return withTypeGuard(db, 'production');
}

export function isDbConnected(): boolean {
  return !!db;
}

export function getSourcesDb(): Nano.DocumentScope<SourceDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<SourceDoc>, 'source');
}

export function getConfigsDb(): Nano.DocumentScope<ProductionConfigDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<ProductionConfigDoc>, 'production-config');
}

export function getGraphicsDb(): Nano.DocumentScope<GraphicDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<GraphicDoc>, 'graphic');
}

export function getOutputsDb(): Nano.DocumentScope<OutputDoc> {
  return withTypeGuard(db as unknown as Nano.DocumentScope<OutputDoc>, 'output');
}

const DB_NAME = 'open-live';

export async function connectDb(): Promise<void> {
  const nano = Nano({ url: config.couchdbUrl, requestDefaults: { timeout: 10_000 } });
  const dbList = await nano.db.list();
  if (!dbList.includes(DB_NAME)) {
    await nano.db.create(DB_NAME);
  }
  db = nano.use<ProductionDoc>(DB_NAME);
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
