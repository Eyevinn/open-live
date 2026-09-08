export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid environment variable ${name}: expected a positive integer, got '${raw}'`);
  }
  return value;
}

function buildCouchdbUrl(): string {
  const raw = requireEnv('COUCHDB_URL');
  const url = new URL(raw);
  // If credentials are already embedded in the URL, leave them as-is.
  if (url.password) return raw;
  const user = process.env['COUCHDB_USER'];
  const password = process.env['COUCHDB_PASSWORD'];
  if (!password) return raw;
  if (user) url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  return url.toString();
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  couchdbUrl: buildCouchdbUrl(),
  stromUrl: process.env['STROM_URL'] ?? 'http://localhost:7000',
  stromToken: process.env['STROM_AUTH_TOKEN'] ?? process.env['STROM_TOKEN'] ?? undefined,
  /** 'osc' = PAT→SAT exchange via token.svc.prod.osaas.io (default for OSC-hosted Strom)
   *  'direct' = API key used as Bearer token directly (self-hosted / non-OSC Strom) */
  stromAuthMode: (process.env['STROM_AUTH_MODE'] ?? 'osc') as 'osc' | 'direct',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
  /**
   * Optional static API key. When set, all /api/v1 routes require:
   *   Authorization: Bearer <API_KEY>
   * Leave unset when running behind OSC's reverse-proxy auth wall.
   */
  apiKey: process.env['API_KEY'] ?? undefined,
  /**
   * Allowed CORS origin(s). Comma-separated list or '*' (wildcard).
   * Defaults to unset (no wildcard): when omitted, cross-origin requests are
   * not permitted rather than being opened to any origin. Set an explicit
   * origin (or comma-separated list) for browser clients.
   */
  corsOrigin: process.env['CORS_ORIGIN'] ?? undefined,
  /**
   * Public base URL used to construct WHIP callback URLs stored in CouchDB.
   * Set this to the externally reachable URL of this service (e.g. https://live.example.com).
   * When not set, falls back to deriving the URL from the incoming request — safe only
   * when Fastify's trustProxy is configured correctly for your reverse proxy setup.
   */
  publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? undefined,
  /**
   * Optional allow-list of hostnames that may be used to build request-derived
   * WHIP callback URLs when PUBLIC_BASE_URL is not set. Comma-separated
   * (e.g. "live.example.com,live2.example.com"). When set, a request whose
   * derived host (from X-Forwarded-Host / Host, via Fastify's trustProxy) is
   * not on this list is rejected rather than persisted — preventing an attacker
   * from injecting X-Forwarded-Host: attacker.com to redirect WHIP clients.
   */
  trustedHosts: (process.env['TRUSTED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  /**
   * Source providers to poll, as a comma-separated list of ids (e.g. "weave").
   * Empty (the default) disables provider sync entirely.
   */
  sourceProviders: (process.env['SOURCE_PROVIDERS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Interval between source provider polls, in milliseconds. */
  sourceProviderPollMs: positiveIntEnv('SOURCE_PROVIDER_POLL_MS', 5000),
} as const;
