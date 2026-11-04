/**
 * A startup error that retrying cannot fix: a bad setting, not an unreachable
 * server (OL-49, issue #619). `connectDbAndInit()` runs under the background
 * retry loop (`post-connect-init.ts`), which would otherwise retry it forever
 * with backoff; it stops instead, and `main.ts` exits the process.
 *
 * Its own module, not `db/index.ts`, so tests that mock the database module
 * still see the real class.
 */
export class FatalStartupError extends Error {
  readonly fatal = true;

  constructor(message: string) {
    super(message);
    this.name = 'FatalStartupError';
  }
}

export function isFatalStartupError(err: unknown): err is FatalStartupError {
  return err instanceof FatalStartupError;
}
