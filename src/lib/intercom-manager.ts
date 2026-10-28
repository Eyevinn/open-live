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

async function authHeaders(): Promise<Record<string, string>> {
  const token = config.intercomManagerToken!;
  let bearer = token;
  if (config.intercomManagerAuthMode === 'osc') {
    try {
      bearer = await getOscServiceToken(token, INTERCOM_MANAGER_SERVICE_ID);
    } catch (err) {
      throw new IntercomManagerError(
        `intercom-manager SAT exchange failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bearer}`,
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
