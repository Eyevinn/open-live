function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function parsePositiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}"`);
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
   * Explicit acknowledgement that this deployment intentionally has no
   * API_KEY because an external layer (e.g. OSC's reverse proxy) handles
   * authentication instead. Must be set independently of NODE_ENV — the
   * deployment tier (NODE_ENV=production) says nothing about whether an
   * external auth layer is present, so it cannot double as this signal.
   * Only meaningful when API_KEY is unset; ignored otherwise.
   */
  trustExternalAuth: parseBoolEnv('TRUST_EXTERNAL_AUTH', false),
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
   * Number of consecutive SRT listener ports to lease from the shared Strom
   * instance at startup. Listener sources must use a port inside the leased range.
   */
  stromPortLeaseSize: parsePositiveIntEnv('STROM_PORT_LEASE_SIZE', 20),
  /**
   * Optional override for the lease client id sent to Strom. Defaults to the
   * hostname of PUBLIC_BASE_URL, or `open-live-<hostname>` when that is unset.
   */
  stromPortLeaseClientId: process.env['STROM_PORT_LEASE_CLIENT_ID'] || undefined,
  /** Set to true to skip port leasing entirely (single-tenant Strom setups). */
  stromPortLeaseDisabled: parseBoolEnv('STROM_PORT_LEASE_DISABLED', false),
} as const;
