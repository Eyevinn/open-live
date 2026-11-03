/**
 * The intercom-manager connection as a runtime setting (issue #617, OL-47,
 * `docs/specs/intercom-connection.md`, ADR-013).
 *
 * Open Live talks to one Open Intercom manager per instance. Before #617 that
 * connection came only from env (`INTERCOM_MANAGER_URL`, `…_TOKEN`,
 * `…_AUTH_MODE`, `INTERCOM_WHIP_AUTH_KEY`), which an OSC-hosted instance cannot
 * set. It is now a stored singleton (`IntercomConnectionDoc`) managed through
 * `/api/v1/intercom-connection`, with the env vars as the fallback.
 *
 * Resolution order (spec §3) — `resolveIntercomConnection()`, the ONE place the
 * `config.intercom*` values are read:
 *   1. the stored connection, when present;
 *   2. else the `INTERCOM_MANAGER_*` env vars (today's behaviour, unchanged);
 *   3. else none (talkback disabled).
 * Nothing is cached: every provisioning, proxy call, teardown and status read
 * resolves again, so a change applies without a restart. (The SAT cache in
 * `strom-token.ts` is keyed by PAT + serviceId, so it never serves a SAT for a
 * stale configuration.)
 *
 * Auth (spec §5): a stored connection to an OSC host (`*.osaas.io`) uses `osc`
 * mode — the instance's own OSC PAT (`config.oscPat`, the `OscAccessToken`
 * option) is exchanged for an `eyevinn-intercom-manager` SAT. It is NEVER the
 * Strom token. Any other host uses `direct` mode with the manager API key the
 * operator entered, plus an optional WHIP key.
 *
 * Secrets (`tokenEnc`, `whipKeyEnc`) are encrypted with the shared
 * credential-encryption key family (ADR-009 Decision 1, ADR-013 D2): the
 * `SRT_PASSPHRASE_KEY` source, which falls back to the backend-generated stored
 * key on OSC. No new key family. NEVER log a decrypted value from this module.
 */

import { config } from '../config.js';
import { getIntercomConnectionDb, isDbConnected } from '../db/index.js';
import type { IntercomConnectionDoc } from '../db/types.js';
import { encryptPassphrase, decryptPassphrase, SRT_PASSPHRASE_KEY_SOURCE } from './srt-passphrase-crypto.js';
import { BLOCKED_HOSTNAMES, isPrivateHost, isTrustedHost } from './url-validation.js';

/** Fixed id of the singleton stored connection. */
export const INTERCOM_CONNECTION_DOC_ID = 'intercom-connection';

export type IntercomAuthMode = 'osc' | 'direct';
export type IntercomConnectionSource = 'stored' | 'env' | 'none';
/** Where the OSC PAT comes from in `osc` mode. */
export type IntercomPatSource = 'OscAccessToken' | 'INTERCOM_MANAGER_TOKEN';

/** The connection in effect, as every intercom-manager call uses it. */
export interface ResolvedIntercomConnection {
  source: 'stored' | 'env';
  /** Manager base URL, normalised: ends in `/api/v1`, no trailing slash. */
  url: string;
  /** `scheme://host[:port]` of `url` — recorded on `ProductionDoc.intercomManagerOrigin`. */
  origin: string;
  mode: IntercomAuthMode;
  /** True when `mode` was set explicitly (stored) rather than inferred. */
  modeOverridden: boolean;
  /** `osc` mode only: where the PAT comes from. */
  patSource?: IntercomPatSource;
  /**
   * The Bearer source: the manager API key in `direct` mode, the OSC PAT in
   * `osc` mode. Undefined = the connection is configured but cannot be used
   * (see `problem`), i.e. talkback stays disabled. NEVER logged or returned.
   */
  credential?: string;
  /** `direct` mode only: the manager's WHIP/WHEP key. NEVER logged or returned. */
  whipKey?: string;
  /** True when a manager API key (direct) / INTERCOM_MANAGER_TOKEN (env) is set. */
  tokenSet: boolean;
  whipKeySet: boolean;
  /** Plain-language reason the connection cannot be used, when `credential` is unset. */
  problem?: string;
  /** Stored connection only. */
  updatedAt?: string;
}

/** Thrown for an unusable operator-supplied manager URL. The message is safe to return in a 400. */
export class IntercomConnectionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntercomConnectionInputError';
  }
}

// ---------------------------------------------------------------------------
// URL normalisation, mode inference, SSRF gate
// ---------------------------------------------------------------------------

/**
 * Normalise an operator-supplied manager URL (spec §5): http(s) only, no
 * credentials, query or fragment; trailing slashes stripped; `/api/v1`
 * appended when the path does not already end with it, so both
 * `https://x.osaas.io` and `https://x.osaas.io/api/v1/` give
 * `https://x.osaas.io/api/v1`.
 *
 * @throws {IntercomConnectionInputError}
 */
export function normalizeIntercomManagerUrl(raw: string): { url: string; origin: string; hostname: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new IntercomConnectionInputError('Manager URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new IntercomConnectionInputError('Manager URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new IntercomConnectionInputError('Manager URL must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new IntercomConnectionInputError('Manager URL must not contain a query string or fragment');
  }
  if (!parsed.hostname) throw new IntercomConnectionInputError('Manager URL must have a host');
  let path = parsed.pathname.replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(path)) path = `${path}/api/v1`;
  return {
    url: `${parsed.origin}${path}`,
    origin: parsed.origin,
    hostname: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
  };
}

/** True when `hostname` is an OSC-hosted service (`osaas.io` or a subdomain). */
export function isOscHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'osaas.io' || host.endsWith('.osaas.io');
}

/** Auth mode inferred from the manager host (spec §5): OSC host → `osc`, else `direct`. */
export function inferIntercomAuthMode(hostname: string): IntercomAuthMode {
  return isOscHost(hostname) ? 'osc' : 'direct';
}

/**
 * SSRF gate for an operator-supplied manager URL (spec §6, ADR-013 D3): open-live
 * sends a Bearer to it, so a private/loopback/link-local IP literal (or
 * `localhost` / a cloud metadata name) is refused unless the host matches
 * `TRUSTED_INTERCOM_HOSTS`. Reuses `isPrivateHost` / `isTrustedHost` — no new
 * matcher. DNS names are not resolved (same limitation as the storage gate).
 *
 * @throws {IntercomConnectionInputError} naming the allowlist.
 */
export function assertIntercomHostAllowed(hostname: string, trusted: readonly string[] = config.trustedIntercomHosts): void {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host) || (isPrivateHost(host) && !isTrustedHost(host, trusted))) {
    throw new IntercomConnectionInputError(
      'Manager URL points at a private/loopback/link-local address; ' +
        'add its IP or CIDR to TRUSTED_INTERCOM_HOSTS to allow it',
    );
  }
}

// ---------------------------------------------------------------------------
// Secrets at rest (shared credential-encryption key family, ADR-009 D1)
// ---------------------------------------------------------------------------

/** Encrypt an intercom secret into an `encv1:` bundle. */
export function encryptIntercomSecret(plaintext: string): string {
  return encryptPassphrase(plaintext, SRT_PASSPHRASE_KEY_SOURCE);
}

/** Decrypt an `encv1:` intercom secret (fail-closed). */
export function decryptIntercomSecret(value: string): string {
  return decryptPassphrase(value, SRT_PASSPHRASE_KEY_SOURCE);
}

// ---------------------------------------------------------------------------
// Stored document
// ---------------------------------------------------------------------------

/**
 * Read the stored connection. `undefined` when none is stored. Throws on a DB
 * failure (routes map that to 503; the resolver falls back, see below).
 */
export async function readStoredIntercomConnection(): Promise<IntercomConnectionDoc | undefined> {
  if (!isDbConnected()) return undefined;
  try {
    return await getIntercomConnectionDb().get(INTERCOM_CONNECTION_DOC_ID);
  } catch (err) {
    if ((err as { statusCode?: number } | null)?.statusCode === 404) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

const OSC_PAT_MISSING =
  'osc mode needs the instance OSC access token (OscAccessToken / OSC_PAT), which is not set on this instance';

function decryptOrProblem(value: string | undefined, what: string): { value?: string; problem?: string } {
  if (!value) return {};
  try {
    return { value: decryptIntercomSecret(value) };
  } catch {
    return { problem: `The stored ${what} could not be decrypted (has the credential-encryption key changed?); set it again` };
  }
}

/** Resolve a stored connection document into the connection in effect. */
export function resolveStoredIntercomConnection(doc: IntercomConnectionDoc): ResolvedIntercomConnection {
  let origin: string;
  try {
    origin = new URL(doc.url).origin;
  } catch {
    origin = doc.url;
  }
  const base = {
    source: 'stored' as const,
    url: doc.url.replace(/\/+$/, ''),
    origin,
    mode: doc.mode,
    modeOverridden: doc.modeOverridden === true,
    tokenSet: !!doc.tokenEnc,
    whipKeySet: !!doc.whipKeyEnc,
    updatedAt: doc.updatedAt,
  };
  if (doc.mode === 'osc') {
    const pat = config.oscPat;
    return {
      ...base,
      patSource: 'OscAccessToken',
      ...(pat ? { credential: pat } : { problem: OSC_PAT_MISSING }),
    };
  }
  const token = decryptOrProblem(doc.tokenEnc, 'manager API key');
  const whip = decryptOrProblem(doc.whipKeyEnc, 'WHIP key');
  const problem =
    token.problem ?? whip.problem ?? (doc.tokenEnc ? undefined : 'direct mode needs the manager API key, which is not set');
  return {
    ...base,
    ...(token.value && !problem ? { credential: token.value } : {}),
    ...(whip.value ? { whipKey: whip.value } : {}),
    ...(problem ? { problem } : {}),
  };
}

/** Normalise the env URL like a stored one; an unparseable value is kept as-is (today's behaviour). */
function envUrl(raw: string): { url: string; origin: string } {
  try {
    const n = normalizeIntercomManagerUrl(raw);
    return { url: n.url, origin: n.origin };
  } catch {
    return { url: raw.replace(/\/+$/, ''), origin: raw };
  }
}

/** The env-var connection (today's behaviour), or undefined when `INTERCOM_MANAGER_URL` is unset. */
export function resolveEnvIntercomConnection(): ResolvedIntercomConnection | undefined {
  const raw = config.intercomManagerUrl;
  if (!raw) return undefined;
  const { url, origin } = envUrl(raw);
  const mode = config.intercomManagerAuthMode;
  const token = config.intercomManagerToken;
  const whipKey = config.intercomWhipAuthKey;
  return {
    source: 'env',
    url,
    origin,
    mode,
    modeOverridden: false,
    ...(mode === 'osc' ? { patSource: 'INTERCOM_MANAGER_TOKEN' as const } : {}),
    ...(token ? { credential: token } : { problem: 'INTERCOM_MANAGER_TOKEN is not set' }),
    ...(mode === 'direct' && whipKey ? { whipKey } : {}),
    tokenSet: !!token,
    whipKeySet: !!whipKey,
  };
}

/**
 * The connection in effect: stored, else env, else undefined (spec §3). Never
 * throws. A DB read failure falls back to env (today's behaviour) — production
 * docs record the manager origin, so a fallback can never address an id on the
 * wrong manager (spec §5).
 */
export async function resolveIntercomConnection(): Promise<ResolvedIntercomConnection | undefined> {
  let doc: IntercomConnectionDoc | undefined;
  try {
    doc = await readStoredIntercomConnection();
  } catch {
    doc = undefined;
  }
  return doc ? resolveStoredIntercomConnection(doc) : resolveEnvIntercomConnection();
}

/** The connection in effect when it can be used (credential present), else undefined. */
export async function activeIntercomConnection(): Promise<ResolvedIntercomConnection | undefined> {
  const conn = await resolveIntercomConnection();
  return conn?.credential ? conn : undefined;
}

// ---------------------------------------------------------------------------
// Repointing safety (spec §5)
// ---------------------------------------------------------------------------

/** Origin of the env-configured manager, or undefined. */
export function envManagerOrigin(): string | undefined {
  const raw = config.intercomManagerUrl;
  return raw ? envUrl(raw).origin : undefined;
}

/**
 * True when an intercom production id recorded against `recordedOrigin` belongs
 * to the manager `conn` points at. A doc without a recorded origin predates
 * #617, so its id was created on the env-configured manager.
 */
export function intercomRecordMatches(
  recordedOrigin: string | undefined,
  conn: Pick<ResolvedIntercomConnection, 'origin'>,
): boolean {
  const recorded = recordedOrigin ?? envManagerOrigin();
  return recorded !== undefined && recorded === conn.origin;
}

// ---------------------------------------------------------------------------
// Status view (spec §2.1) — NEVER a secret value
// ---------------------------------------------------------------------------

export interface IntercomConnectionStatus {
  source: IntercomConnectionSource;
  /** True when talkback can use this connection (credential present). */
  configured: boolean;
  url: string | null;
  mode: IntercomAuthMode | null;
  modeOverridden: boolean;
  tokenSet: boolean;
  whipKeySet: boolean;
  patSource: IntercomPatSource | null;
  /** Whether the instance OSC PAT (`OscAccessToken` / `OSC_PAT`) is present. */
  oscPatSet: boolean;
  problem: string | null;
  updatedAt: string | null;
}

export function intercomConnectionStatus(conn: ResolvedIntercomConnection | undefined): IntercomConnectionStatus {
  return {
    source: conn?.source ?? 'none',
    configured: !!conn?.credential,
    url: conn?.url ?? null,
    mode: conn?.mode ?? null,
    modeOverridden: conn?.modeOverridden ?? false,
    tokenSet: conn?.tokenSet ?? false,
    whipKeySet: conn?.whipKeySet ?? false,
    patSource: conn?.patSource ?? null,
    oscPatSet: !!config.oscPat,
    problem: conn ? (conn.problem ?? null) : 'No intercom connection is configured; talkback is off',
    updatedAt: conn?.updatedAt ?? null,
  };
}
