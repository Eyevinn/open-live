import { parseHostPatterns } from './lib/url-validation.js';

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
  /**
   * Accept provider-listed SRT addresses on private, loopback or link-local
   * hosts. Off by default, which keeps srtUrl()'s SSRF rule intact everywhere.
   *
   * A provider address is not attacker-supplied: it comes from the system named
   * in SOURCE_PROVIDERS, over the URL the operator configured. Providers that
   * place media on container or cluster networks — open-weave puts SRT outputs
   * on a node subnet — produce RFC1918 addresses for every source, so the rule
   * would reject all of them. This does not relax the REST routes, where an
   * address does arrive in a request body.
   */
  sourceProviderAllowPrivateHosts: process.env['SOURCE_PROVIDER_ALLOW_PRIVATE_HOSTS'] === 'true',
  /**
   * Hosts a provider may name, as a comma-separated list of hostnames, IPs and
   * CIDR blocks (e.g. "10.42.0.0/16,weave-1.internal"). When set, a candidate
   * address outside the list is skipped whether its host is private or public,
   * and SOURCE_PROVIDER_ALLOW_PRIVATE_HOSTS is not consulted.
   *
   * The list is the one input to provider validation that the provider does not
   * supply, so it is what bounds a provider that starts returning addresses it
   * should not. Prefer it over the blanket private-host waiver.
   */
  sourceProviderAllowedHosts: parseHostPatterns(
    (process.env['SOURCE_PROVIDER_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter(Boolean),
  ),
} as const;
