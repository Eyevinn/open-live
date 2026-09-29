/**
 * A deployment-misconfiguration error that must reach the client as a clear,
 * non-500 response instead of the generic "An internal error occurred" body.
 *
 * The credential-encryption modules (`srt-passphrase-crypto`, `html-auth-crypto`)
 * fail closed when no encryption key is configured in production (ADR-003
 * Decision 4): they refuse to store a secret in plaintext. Before #349 that
 * failure surfaced as a bare `Error`, which the global handler in `server.ts`
 * mapped to a 500 with a useless generic body — indistinguishable from a real
 * server fault (issue #349, confirmed live on OSC-provisioned instances where
 * neither `HTML_AUTH_KEY` nor `SRT_PASSPHRASE_KEY` is set).
 *
 * `statusCode = 503` tells operators/clients the request could not be served
 * because of a *server configuration* gap, not a bad request and not a bug. The
 * fail-closed behaviour is unchanged — nothing is ever stored in plaintext; only
 * the surfaced status/message improves.
 *
 * `expose = true` opts this error's message into being returned verbatim by the
 * global error handler. The handler otherwise suppresses 5xx messages to avoid
 * leaking internals; a ConfigurationError's message is deliberately safe (an
 * operator-facing hint that names the missing env var, never a secret or stack).
 */
export class ConfigurationError extends Error {
  readonly statusCode = 503;
  /** Opt the message into the global handler's 5xx passthrough (safe by design). */
  readonly expose = true;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/** True when an unknown error opted its message into the 5xx passthrough. */
export function isExposableError(err: unknown): err is Error & { expose: true } {
  return (
    err instanceof Error &&
    'expose' in err &&
    (err as { expose?: unknown }).expose === true
  );
}
