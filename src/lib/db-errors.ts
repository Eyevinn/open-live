/**
 * Classifies a CouchDB `.get()` failure.
 *
 * A document is "not found" when CouchDB answers 404, or when the id names a
 * document of another type (the `withTypeGuard` mismatch in `src/db/index.ts`).
 * Anything else (connection refused, timeout, 5xx) is the database being
 * unavailable, which callers should report as 503 rather than 404.
 *
 * Kept outside `src/db/index.ts` on purpose: many tests replace that module
 * wholesale with `vi.mock`, which would drop this helper.
 */
export function isDocNotFoundError(err: unknown): boolean {
  if ((err as { statusCode?: number } | null)?.statusCode === 404) return true;
  return err instanceof Error && err.message.startsWith('Document type mismatch');
}
