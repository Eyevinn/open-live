/**
 * Open Intercom manager (Eyevinn/intercom-manager) HTTP client — talkback line
 * provisioning for guest calling (epic #208, issue #302,
 * `docs/specs/guest-calling-intercom.md` §"Service Interactions", §Configuration).
 *
 * Per OQ1 (@svensson00, #208) Open Intercom carries operator↔guest talkback
 * AUDIO ONLY — guest production video rides Open Live's own WHIP path. So this
 * client only provisions audio talkback lines and never touches intercom video.
 *
 * The client is thin and matches the intercom-manager line/production model: an
 * intercom "production" groups a set of talkback lines, and each line exposes a
 * WebRTC endpoint an operator and a guest can both join. Open Live keeps the
 * production grouping id (`ProductionDoc.intercomProductionId`) so lines can be
 * provisioned and torn down with the Open Live production lifecycle.
 *
 * SECURITY: the base URL is fixed server-side config (`INTERCOM_MANAGER_URL`),
 * never caller-supplied, so this cannot be turned into an SSRF. The auth token
 * (`INTERCOM_MANAGER_TOKEN`) is held server-side only and redacted in logs
 * (`src/lib/log-redact.ts`).
 *
 * Degrades cleanly (spec §Configuration; guest-talkback spec §3.6, issue #598):
 * callers gate on `isIntercomEnabled()` and skip provisioning when the vars are
 * unset. When the vars ARE set but the manager is unreachable, errors, or
 * answers with an unexpected shape, this throws `IntercomManagerError`; guest
 * join catches it, logs at warn level and still answers `200` without
 * `intercomLine` (talkback hidden, the rest of the join unaffected). Join never
 * fails because of intercom.
 *
 * Real manager API (verified against Eyevinn/intercom-manager, guest-talkback
 * spec §3.1): `INTERCOM_MANAGER_URL` includes `/api/v1`;
 * `POST /production` → `{ name, productionId }`;
 * `GET|POST /production/:p/line` → `LineResponse[]` (every line of the
 * production); a duplicate line name on POST → `400 { message }`. No manager
 * response carries a join URL.
 *
 * Auth (`INTERCOM_MANAGER_AUTH_MODE`, spec OQ3): `direct` sends
 * `INTERCOM_MANAGER_TOKEN` as the Bearer; `osc` exchanges it (an OSC PAT) for a
 * Service Access Token scoped to `eyevinn-intercom-manager`.
 */

import { config } from '../config.js';
import { getOscServiceToken } from './strom-token.js';

/** OSC serviceId of the intercom manager, for the PAT→SAT exchange in `osc` mode. */
export const INTERCOM_MANAGER_SERVICE_ID = 'eyevinn-intercom-manager';

/** True when both intercom-manager vars are set, i.e. talkback is enabled. */
export function isIntercomEnabled(): boolean {
  return Boolean(config.intercomManagerUrl && config.intercomManagerToken);
}

/**
 * Talkback line name for a guest slot (spec §3.6 / OQ4): one line per slot,
 * stable across occupants and rejoins, unique per intercom production. The
 * operator-facing guest name stays the invite label — this is internal.
 */
export function guestLineName(mixerInput: string): string {
  return `guest-${mixerInput}`;
}

/** The talkback line handed to a guest on join (spec §3.4: `intercomLine`). */
export interface IntercomLine {
  /** intercom-manager line id (persisted as `GuestSessionDoc.intercomLineId`). */
  id: string;
  /** intercom-manager production grouping id (persisted as `ProductionDoc.intercomProductionId`). */
  productionId: string;
  /** Line name on the manager (`guest-<mixerInput>`). */
  name: string;
}

/** Raised when the intercom manager is unreachable, returns a non-2xx status, or an unexpected shape. */
export class IntercomManagerError extends Error {
  /** HTTP status from the manager, when it answered at all. */
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'IntercomManagerError';
    if (status !== undefined) this.status = status;
  }
}

function baseUrl(): string {
  // Non-null by contract: callers must gate on isIntercomEnabled() first.
  return config.intercomManagerUrl!.replace(/\/+$/, '');
}

/**
 * The Bearer value for intercom-manager management calls: `INTERCOM_MANAGER_TOKEN`
 * as-is in `direct` mode, or the Service Access Token it is exchanged for in
 * `osc` mode. Shared by the management client (`authHeaders`) and the talkback
 * WHIP/WHEP proxy (`talkbackAuthorization`), so the SAT path lives in one place.
 *
 * @throws {IntercomManagerError} when the `osc` SAT exchange fails.
 */
export async function managerBearer(): Promise<string> {
  const token = config.intercomManagerToken!;
  if (config.intercomManagerAuthMode !== 'osc') return token;
  try {
    return await getOscServiceToken(token, INTERCOM_MANAGER_SERVICE_ID);
  } catch (err) {
    throw new IntercomManagerError(
      `intercom-manager SAT exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await managerBearer()}`,
  };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const headers = await authHeaders();
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers });
  } catch (err) {
    throw new IntercomManagerError(
      `intercom-manager unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new IntercomManagerError(
      `intercom-manager error: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
      res.status,
    );
  }
  return res.status === 204 ? undefined : await res.json().catch(() => undefined);
}

/**
 * Pick the line named `name` out of a manager `LineResponse[]` body. Returns
 * its id, or undefined when absent. Throws when the body is not an array —
 * the manager always answers line routes with the production's full list.
 */
function findLineId(body: unknown, name: string): string | undefined {
  if (!Array.isArray(body)) {
    throw new IntercomManagerError('intercom-manager returned an unexpected line list shape');
  }
  for (const entry of body as Array<{ id?: unknown; name?: unknown } | null>) {
    if (entry && entry.name === name) {
      if (typeof entry.id === 'string' && entry.id) return entry.id;
      if (typeof entry.id === 'number') return String(entry.id);
    }
  }
  return undefined;
}

/**
 * Provision (or reuse) the talkback line for a guest slot on an Open Live
 * production (spec §3.6):
 *
 *  1. When `intercomProductionId` is unknown, create the production grouping.
 *  2. `GET /production/:p/line` and reuse the line whose name matches.
 *  3. Only when it is missing, `POST /production/:p/line` and pick the matching
 *     entry from the returned `LineResponse[]`.
 *  4. A duplicate-name `400` on that POST is a race (another join created it
 *     between 2 and 3): re-`GET` and use the existing line.
 *
 * Returns the line plus the grouping id the caller records on the production doc.
 *
 * @throws {IntercomManagerError} on unreachable/non-2xx/unexpected shape —
 *   callers degrade (join answers 200 without `intercomLine`).
 */
export async function provisionGuestLine(opts: {
  /** Existing intercom production grouping id, if one was created earlier. */
  intercomProductionId?: string;
  /** Open Live production id, used to name the grouping on first creation. */
  productionId: string;
  /** Line name — `guestLineName(mixerInput)`, one line per guest slot. */
  lineName: string;
}): Promise<IntercomLine> {
  let productionId = opts.intercomProductionId;

  if (!productionId) {
    const created = (await request('/production', {
      method: 'POST',
      body: JSON.stringify({ name: `open-live-${opts.productionId}`, lines: [] }),
    })) as { productionId?: unknown; id?: unknown } | undefined;
    const id = created?.productionId ?? created?.id;
    if (typeof id === 'string' && id) productionId = id;
    else if (typeof id === 'number') productionId = String(id);
    else throw new IntercomManagerError('intercom-manager returned no production id');
  }

  const linesPath = `/production/${encodeURIComponent(productionId)}/line`;
  const line = (id: string): IntercomLine => ({ id, productionId: productionId!, name: opts.lineName });

  // 2. Reuse an existing line for this slot (rejoin, or the slot's next occupant).
  const existing = findLineId(await request(linesPath, { method: 'GET' }), opts.lineName);
  if (existing) return line(existing);

  // 3. Missing: create it. The manager answers with every line of the production.
  let created: unknown;
  try {
    created = await request(linesPath, {
      method: 'POST',
      body: JSON.stringify({ name: opts.lineName }),
    });
  } catch (err) {
    // 4. Duplicate name → a concurrent join created it first. Use that line.
    if (err instanceof IntercomManagerError && err.status === 400) {
      const raced = findLineId(await request(linesPath, { method: 'GET' }), opts.lineName);
      if (raced) return line(raced);
    }
    throw err;
  }
  const id = findLineId(created, opts.lineName);
  if (!id) {
    throw new IntercomManagerError('intercom-manager line list has no line with the requested name');
  }
  return line(id);
}

/**
 * Tear down the intercom production grouping (and all its lines) for an Open
 * Live production. Best-effort — teardown rides the production lifecycle and
 * must not block deactivation, so callers ignore failures.
 */
export async function teardownIntercomProduction(intercomProductionId: string): Promise<void> {
  await request(`/production/${encodeURIComponent(intercomProductionId)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Talkback WHIP/WHEP proxy (guest-talkback spec §3.1–§3.3, §7, R4; ADR-012;
// issue #599). open-live holds the manager's one global WHIP/WHEP Bearer and
// proxies signalling for the guest page and Studio, so no browser ever talks to
// the manager or sees the key.
//
// R4 (SSRF / key exfiltration): manager URLs are built only from
// `INTERCOM_MANAGER_URL` plus ids open-live read from its own DB, each checked
// here — production and line ids against `^[0-9]+$`, session ids against a
// UUID. The only client-supplied input forwarded is the opaque SDP body. A
// manager `Location` that is not `/api/v1/{whip|whep}/<p>/<l>/<uuid>` on the
// manager origin is rejected (the `assertSameStromOrigin` discipline).
//
// The manager's management client (`request()` above) is not reused: it forces
// JSON and parses the body, while this proxy passes SDP through untouched and
// needs the raw `Location`, `ETag` and `Retry-After` headers. The manager's
// `Link` header (ICE servers, possibly long-lived TURN credentials) is never
// read or forwarded.
// ---------------------------------------------------------------------------

/** The two talkback resources: WHIP publishes into the line, WHEP listens to it. */
export type TalkbackKind = 'whip' | 'whep';

const NUMERIC_ID = /^[0-9]+$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Largest SDP offer the proxy forwards (the manager's own limit, spec §3.1). */
export const TALKBACK_SDP_MAX_BYTES = 64 * 1024;
/** Upper bound on one proxied manager call, so a hung manager cannot hold a request open. */
const TALKBACK_TIMEOUT_MS = 10_000;
/** `Retry-After` sent with a `503` when the manager's own `429` carries none usable. */
const DEFAULT_RETRY_AFTER_S = '5';

/** True if `id` is a UUID — the only session-id shape the manager mints or accepts. */
export function isTalkbackSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

/** True if both ids have the numeric shape the manager uses (`^[0-9]+$`). */
export function isTalkbackLineRef(productionId: string, lineId: string): boolean {
  return NUMERIC_ID.test(productionId) && NUMERIC_ID.test(lineId);
}

/**
 * Username the manager shows for a talkback participant (spec §3.2): every
 * character outside `[\w .-]` becomes `_`, cut to 200 characters (the manager's
 * `^[\w .-]{1,200}$` path rule). Blank → `fallback`.
 */
export function talkbackUsername(raw: string | null | undefined, fallback: string): string {
  const clean = (raw ?? '').replace(/[^\w .-]/g, '_').slice(0, 200);
  return clean.trim() ? clean : fallback.replace(/[^\w .-]/g, '_').slice(0, 200);
}

/**
 * The `Authorization` value for the manager's WHIP/WHEP endpoints (spec §7,
 * OQ3): the SAT in `osc` mode (via `managerBearer`), else
 * `INTERCOM_WHIP_AUTH_KEY`, else none (manager WHIP auth off). Never logged.
 */
export async function talkbackAuthorization(): Promise<string | undefined> {
  if (config.intercomManagerAuthMode === 'osc') return `Bearer ${await managerBearer()}`;
  return config.intercomWhipAuthKey ? `Bearer ${config.intercomWhipAuthKey}` : undefined;
}

/** Remove the WHIP key from any manager-supplied text before it reaches a client or a log. */
function scrubKey(text: string): string {
  const key = config.intercomWhipAuthKey;
  return key ? text.split(key).join('[REDACTED]') : text;
}

/** Minimal logger shape (Fastify's logger fits). Only messages and status codes are logged — never headers. */
export interface TalkbackLog {
  warn(obj: object, msg: string): void;
}

/** Outcome of a proxied WHIP/WHEP offer. Error bodies are safe to send to the client. */
export type TalkbackOfferResult =
  | { ok: true; sessionId: string; answer: string }
  | { ok: false; status: 400 | 404 | 406 | 415 | 502 | 503; error: string; retryAfter?: string };

/** Outcome of a proxied session DELETE. `gone` = the manager said `404` (already ended). */
export type TalkbackDeleteResult =
  | { ok: true; outcome: 'deleted' | 'gone' }
  | { ok: false; status: 502 | 503; error: string; retryAfter?: string };

const UNREACHABLE = 'Intercom manager unreachable';

function managerUrl(kind: TalkbackKind, productionId: string, lineId: string, tail: string): string {
  return `${baseUrl()}/${kind}/${productionId}/${lineId}/${encodeURIComponent(tail)}`;
}

/**
 * Validate a manager `Location` + `ETag` pair on a `201` and return the session
 * id, or undefined when it is not exactly `/api/v1/<kind>/<p>/<l>/<uuid>` (or
 * the same under the configured base path) on the manager origin with
 * `ETag` = that uuid. Exported for tests.
 */
export function managerSessionIdFromLocation(
  location: string | null,
  etag: string | null,
  kind: TalkbackKind,
  productionId: string,
  lineId: string,
): string | undefined {
  if (!location) return undefined;
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(baseUrl());
    resolved = new URL(location, `${base.origin}/`);
  } catch {
    return undefined;
  }
  if (resolved.origin !== base.origin || resolved.search || resolved.hash) return undefined;
  const sessionId = resolved.pathname.split('/').pop() ?? '';
  if (!UUID_RE.test(sessionId)) return undefined;
  const tail = `/${kind}/${productionId}/${lineId}/${sessionId}`;
  const basePath = base.pathname.replace(/\/+$/, '');
  if (resolved.pathname !== `/api/v1${tail}` && resolved.pathname !== `${basePath}${tail}`) return undefined;
  const tag = (etag ?? '').trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
  if (tag !== sessionId) return undefined;
  return sessionId;
}

function retryAfterOf(res: Response): string {
  const value = res.headers.get('retry-after')?.trim();
  return value && /^[0-9]{1,5}$/.test(value) ? value : DEFAULT_RETRY_AFTER_S;
}

/** Turn a manager error body into a short, key-free message for a pass-through status. */
async function managerMessage(res: Response, fallback: string): Promise<string> {
  const text = (await res.text().catch(() => '')).trim();
  let message = text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
    if (typeof parsed?.message === 'string') message = parsed.message;
    else if (typeof parsed?.error === 'string') message = parsed.error;
  } catch {
    /* plain-text body */
  }
  message = scrubKey(message).slice(0, 200);
  return message || fallback;
}

/**
 * Proxy one WHIP/WHEP offer to `POST /<kind>/:p/:l/:username` (spec §3.1–§3.2)
 * and map the manager's answer onto open-live's contract:
 * `201` → session id + SDP answer; `400` → `400 Malformed SDP`;
 * `404` → `404 Talkback unavailable`; `406` → pass-through; `415` → `415`;
 * `429` → `503 Intercom manager busy` + `Retry-After`; `401` (key mismatch),
 * any other status, a network error, or a bad `Location`/`ETag` → `502`.
 * Callers must gate on `isIntercomEnabled()` first.
 */
export async function postTalkbackOffer(opts: {
  kind: TalkbackKind;
  productionId: string;
  lineId: string;
  username: string;
  sdp: string;
  log: TalkbackLog;
}): Promise<TalkbackOfferResult> {
  const { kind, productionId, lineId, log } = opts;
  if (!isTalkbackLineRef(productionId, lineId)) {
    log.warn({ kind }, 'talkback: stored intercom production/line id is not numeric; refusing to proxy');
    return { ok: false, status: 404, error: 'Talkback unavailable' };
  }
  let res: Response;
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    const authorization = await talkbackAuthorization();
    if (authorization) headers['Authorization'] = authorization;
    res = await fetch(managerUrl(kind, productionId, lineId, opts.username), {
      method: 'POST',
      headers,
      body: opts.sdp,
      redirect: 'manual',
      signal: AbortSignal.timeout(TALKBACK_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn(
      { kind, reason: scrubKey(err instanceof Error ? err.message : String(err)) },
      'talkback: intercom-manager unreachable',
    );
    return { ok: false, status: 502, error: UNREACHABLE };
  }

  if (res.status === 201) {
    const sessionId = managerSessionIdFromLocation(
      res.headers.get('location'),
      res.headers.get('etag'),
      kind,
      productionId,
      lineId,
    );
    if (!sessionId) {
      await res.body?.cancel().catch(() => undefined);
      log.warn({ kind }, 'talkback: intercom-manager returned an unexpected Location/ETag; rejecting');
      return { ok: false, status: 502, error: UNREACHABLE };
    }
    return { ok: true, sessionId, answer: await res.text() };
  }

  switch (res.status) {
    case 400:
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: 400, error: 'Malformed SDP' };
    case 401:
      await res.body?.cancel().catch(() => undefined);
      log.warn({ kind, status: 401 }, 'talkback: intercom-manager rejected INTERCOM_WHIP_AUTH_KEY');
      return { ok: false, status: 502, error: UNREACHABLE };
    case 404:
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: 404, error: 'Talkback unavailable' };
    case 406:
      return { ok: false, status: 406, error: await managerMessage(res, 'Not Acceptable') };
    case 415:
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: 415, error: 'Unsupported Media Type' };
    case 429:
      await res.body?.cancel().catch(() => undefined);
      log.warn({ kind, status: 429 }, 'talkback: intercom-manager rate limit (429)');
      return { ok: false, status: 503, error: 'Intercom manager busy', retryAfter: retryAfterOf(res) };
    default:
      await res.body?.cancel().catch(() => undefined);
      log.warn({ kind, status: res.status }, 'talkback: intercom-manager error');
      return { ok: false, status: 502, error: UNREACHABLE };
  }
}

/**
 * Proxy `DELETE /<kind>/:p/:l/:sessionId` (spec §3.1). The manager's `200` and
 * `404` (already gone) both count as success. `429` → `503` + `Retry-After`;
 * anything else, a network error, or an id that fails the R4 shape checks →
 * `502`. Callers must gate on `isIntercomEnabled()` first.
 */
export async function deleteTalkbackSession(opts: {
  kind: TalkbackKind;
  productionId: string;
  lineId: string;
  sessionId: string;
  log: TalkbackLog;
}): Promise<TalkbackDeleteResult> {
  const { kind, productionId, lineId, sessionId, log } = opts;
  if (!isTalkbackLineRef(productionId, lineId) || !UUID_RE.test(sessionId)) {
    log.warn({ kind }, 'talkback: refusing DELETE with a non-numeric line ref or non-UUID session id');
    return { ok: false, status: 502, error: UNREACHABLE };
  }
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    const authorization = await talkbackAuthorization();
    if (authorization) headers['Authorization'] = authorization;
    res = await fetch(managerUrl(kind, productionId, lineId, sessionId), {
      method: 'DELETE',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(TALKBACK_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn(
      { kind, reason: scrubKey(err instanceof Error ? err.message : String(err)) },
      'talkback: intercom-manager unreachable on DELETE',
    );
    return { ok: false, status: 502, error: UNREACHABLE };
  }
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true, outcome: 'deleted' };
  if (res.status === 404) return { ok: true, outcome: 'gone' };
  if (res.status === 429) {
    log.warn({ kind, status: 429 }, 'talkback: intercom-manager rate limit (429) on DELETE');
    return { ok: false, status: 503, error: 'Intercom manager busy', retryAfter: retryAfterOf(res) };
  }
  if (res.status === 401) {
    log.warn({ kind, status: 401 }, 'talkback: intercom-manager rejected INTERCOM_WHIP_AUTH_KEY');
  } else {
    log.warn({ kind, status: res.status }, 'talkback: intercom-manager error on DELETE');
  }
  return { ok: false, status: 502, error: UNREACHABLE };
}
