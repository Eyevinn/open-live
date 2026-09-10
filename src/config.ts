function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
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
   * OSC Personal Access Token, held server-side only. Exchanged for a
   * short-lived SAT via POST /api/v1/auth/token (issue #204) so browser
   * clients (e.g. open-live-studio) never hold the PAT. NEVER returned to a
   * client.
   */
  oscPat: process.env['OSC_PAT'] ?? undefined,
  /**
   * The OSC serviceId that SATs minted via /api/v1/auth/token are scoped to.
   * Fixed server-side config (never caller-supplied) so the token endpoint
   * cannot be redirected at an arbitrary service (anti-SSRF / privilege
   * escalation).
   */
  oscSatServiceId: process.env['OSC_SAT_SERVICE_ID'] ?? 'eyevinn-strom',
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
} as const;
