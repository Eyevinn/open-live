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

/**
 * Redact any `user:pass@` userinfo segment from a URL-ish string so a malformed
 * value can be safely echoed in an error message without leaking credentials.
 * Operates on the raw string (the value may not be parseable), replacing the
 * password — and, defensively, the username — with `***`.
 */
function redactUrlCredentials(raw: string): string {
  // Match an authority userinfo segment: scheme://[user[:pass]]@host...
  return raw.replace(
    /(^[^:/?#\s]+:\/\/)([^/?#@]*)@/,
    (_full, scheme: string, userinfo: string) => {
      const user = userinfo.split(':', 1)[0];
      return `${scheme}${user ? `${user}:***` : '***'}@`;
    },
  );
}

/**
 * Parse `COUCHDB_URL`. On OSC the value is derived by osc-entrypoint.sh, which
 * can produce a truncated string like `https:/` when the operator's DatabaseUrl
 * has no `/dbname` path (issue #288). `new URL()` then throws an opaque
 * `TypeError: Invalid URL` that is very hard to diagnose. Wrap the parse so the
 * failure names the env var and shows the (credential-redacted) value plus the
 * expected form.
 */
export function buildCouchdbUrl(): string {
  const raw = requireEnv('COUCHDB_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `Invalid COUCHDB_URL: "${redactUrlCredentials(raw)}" is not a valid URL. ` +
        `Expected the form http(s)://[user:pass@]host[:port]/dbname.`,
    );
  }
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
   * Optional public hostname on which the shared Strom instance's SRT listener
   * ports are reachable from external SRT callers. Used to build the read-only
   * `connect` dial-in address surfaced on `mpegtssrt`/`efpsrt` outputs.
   *
   * The SRT-facing host is conceptually independent of the HTTP API host
   * (`STROM_URL`): the SRT listener is a separate raw transport port, and in
   * NATed / shared-GPU topologies it may be published on a different hostname.
   * When unset, the host is derived from the `STROM_URL` hostname; when that is
   * loopback/private the `connect` address is returned as `null` with a reason
   * rather than emitting a misleading address. Set this to override for
   * deployments where the SRT port is reachable on a distinct public host.
   */
  srtPublicHost: process.env['SRT_PUBLIC_HOST'] || undefined,
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
  stromPortLeaseSize: parsePositiveIntEnv('STROM_PORT_LEASE_SIZE', 10),
  /**
   * Optional override for the lease client id sent to Strom. Defaults to the
   * hostname of PUBLIC_BASE_URL, or `open-live-<hostname>` when that is unset.
   */
  stromPortLeaseClientId: process.env['STROM_PORT_LEASE_CLIENT_ID'] || undefined,
  /** Set to true to skip port leasing entirely (single-tenant Strom setups). */
  stromPortLeaseDisabled: parseBoolEnv('STROM_PORT_LEASE_DISABLED', false),
  // --- OL-5 Studio Gateways Phase 1 (issue #263, docs/specs/studio-gateways.md) ---
  /**
   * Heartbeat age (seconds) past which a gateway reads as `down`. Health is
   * derived on read from `lastSeenAt`; there is no persisted health flag. The
   * default tolerates two missed 5s heartbeats.
   */
  gatewayDownAfterSeconds: parsePositiveIntEnv('GATEWAY_DOWN_AFTER_SECONDS', 15),
  /**
   * Recommended heartbeat cadence (seconds) advertised to the gateway in the
   * HELLO frame. Advisory only — the gateway drives its own timer.
   */
  gatewayHeartbeatIntervalSeconds: parsePositiveIntEnv('GATEWAY_HEARTBEAT_INTERVAL_SECONDS', 5),
  /**
   * Minimum interval (ms) between CouchDB writes of a gateway's snapshot, to
   * cap heartbeat write amplification. Identical back-to-back heartbeats within
   * this window debounce to at most one write.
   */
  gatewayHeartbeatPersistMinIntervalMs: parsePositiveIntEnv('GATEWAY_HEARTBEAT_PERSIST_MIN_INTERVAL_MS', 5000),
  /**
   * Minimum offline duration (seconds) before DELETE /api/v1/gateways/:id is
   * allowed — the "zombie-sources escape hatch" that must not delete a live
   * gateway out from under a running show.
   */
  gatewayForgetMinOfflineSeconds: parsePositiveIntEnv('GATEWAY_FORGET_MIN_OFFLINE_SECONDS', 300),
  /**
   * MinIO / S3 object storage for VOD recordings (epic #5, issue #41).
   *
   * Strom's recorder writes local files only ({media_path}/{output_dir}/{prefix}_%05d.{ext},
   * backend/src/blocks/builtin/recorder.rs) — it has no native S3/MinIO sink. So open-live
   * uploads the recorder's local segments to object storage after a production deactivates,
   * fetching them via Strom's existing media download API (`GET /api/media/file/:path`).
   *
   * When these vars are unset the `recording` output type is rejected at assignment time
   * (400 — recording disabled), mirroring how STROM_URL / API_KEY degrade cleanly.
   * `MINIO_ENDPOINT` falls back to `S3_ENDPOINT` for S3-compatible naming.
   */
  minioEndpoint: process.env['MINIO_ENDPOINT'] ?? process.env['S3_ENDPOINT'] ?? undefined,
  minioAccessKey: process.env['MINIO_ACCESS_KEY'] ?? undefined,
  minioSecretKey: process.env['MINIO_SECRET_KEY'] ?? undefined,
  minioBucket: process.env['MINIO_BUCKET'] ?? undefined,
  minioRegion: process.env['MINIO_REGION'] ?? 'us-east-1',
  minioUseSsl: parseBoolEnv('MINIO_USE_SSL', true),
  /** Optional prefix prepended to every recording object key. */
  recordingKeyPrefix: process.env['RECORDING_KEY_PREFIX'] ?? '',
  /** Presigned playback URL TTL in seconds (used by #42's listing endpoint). */
  recordingPresignTtlS: parsePositiveIntEnv('RECORDING_PRESIGN_TTL_S', 3600),
  /**
   * Interval (ms) at which the WS layer polls `player.getState` to detect clip
   * completion when Strom does not push player-state changes (epic #206,
   * issues #277/#278; spec §"Configuration"). Completion latency is bounded by
   * one poll interval (≤ this value). Default 250 ms.
   */
  clipStatePollMs: parsePositiveIntEnv('CLIP_STATE_POLL_MS', 250),
  /**
   * Idle auto-deactivation timeout in seconds (issue #290). A running production
   * with zero connected controller sockets is auto-deactivated once it has been
   * idle for this long (`endedReason: 'idle'`, `autoDeactivated: true`). Defaults
   * to the historical 300s (5 min) deadline.
   */
  idleTimeoutSeconds: parsePositiveIntEnv('IDLE_TIMEOUT_SECONDS', 300),
  /**
   * Lead time in seconds before the idle deadline at which the watchdog emits a
   * single `IDLE_WARNING` broadcast to connected controller sockets so a client
   * can surface a "keep the show up" countdown (issue #290; consumed by
   * open-live-studio#130). Reconnecting/activity resets the timer and clears the
   * pending warning. Clamped to the idle timeout so it never exceeds the deadline.
   * Default 60s.
   */
  idleWarningLeadSeconds: parsePositiveIntEnv('IDLE_WARNING_LEAD_SECONDS', 60),
} as const;

/**
 * True when all required MinIO vars are present, i.e. VOD recording is enabled.
 * The `recording` output type is only accepted, and the recorder block only
 * wired into the flow, when this returns true (spec: config-gated feature).
 */
export function isRecordingEnabled(): boolean {
  return Boolean(
    config.minioEndpoint &&
      config.minioAccessKey &&
      config.minioSecretKey &&
      config.minioBucket,
  );
}
