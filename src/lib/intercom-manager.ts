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
 * Degrades cleanly (spec §Configuration, OQ1): callers gate on
 * `isIntercomEnabled()` and skip provisioning when the vars are unset. When the
 * vars ARE set but the manager is unreachable/errors during an explicitly
 * enabled provision, this throws `IntercomManagerError` and the caller surfaces
 * a 502/503 — an operator asked for talkback and it could not be delivered.
 */

import { config } from '../config.js';

/** True when both intercom-manager vars are set, i.e. talkback is enabled. */
export function isIntercomEnabled(): boolean {
  return Boolean(config.intercomManagerUrl && config.intercomManagerToken);
}

/** The talkback line handed to a guest on join (spec §"Guest join": `intercomLine`). */
export interface IntercomLine {
  /** intercom-manager line id (persisted as `GuestSessionDoc.intercomLineId`). */
  id: string;
  /** intercom-manager production grouping id (persisted as `ProductionDoc.intercomProductionId`). */
  productionId: string;
  /** Human-readable name the operator sees for this line. */
  name: string;
  /** WebRTC join URL the guest client uses to reach the talkback line. */
  joinUrl?: string;
}

/** Raised when the intercom manager is unreachable or returns a non-2xx status. */
export class IntercomManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntercomManagerError';
  }
}

function baseUrl(): string {
  // Non-null by contract: callers must gate on isIntercomEnabled() first.
  return config.intercomManagerUrl!.replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.intercomManagerToken}`,
  };
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { ...init, headers: authHeaders() });
  } catch (err) {
    throw new IntercomManagerError(
      `intercom-manager unreachable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new IntercomManagerError(
      `intercom-manager error: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
    );
  }
  return res.status === 204 ? undefined : await res.json().catch(() => undefined);
}

/**
 * Provision (or attach to) a talkback line for a guest on an Open Live
 * production. Idempotent per production: when `intercomProductionId` is already
 * known it attaches a line to that grouping; otherwise it creates the grouping
 * first. Returns the line plus the grouping id the caller records on the
 * production doc.
 *
 * @throws {IntercomManagerError} on unreachable/non-2xx — surfaced as 502/503.
 */
export async function provisionGuestLine(opts: {
  /** Existing intercom production grouping id, if one was created earlier. */
  intercomProductionId?: string;
  /** Open Live production id, used to name the grouping on first creation. */
  productionId: string;
  /** Line label the operator sees (e.g. the guest's mixer input or invite label). */
  lineName: string;
}): Promise<IntercomLine> {
  let productionId = opts.intercomProductionId;

  if (!productionId) {
    const created = (await request('/production', {
      method: 'POST',
      body: JSON.stringify({ name: `open-live-${opts.productionId}`, lines: [] }),
    })) as { productionId?: unknown; id?: unknown } | undefined;
    const id = created?.productionId ?? created?.id;
    if (typeof id !== 'string') {
      throw new IntercomManagerError('intercom-manager returned no production id');
    }
    productionId = id;
  }

  const line = (await request(`/production/${encodeURIComponent(productionId)}/line`, {
    method: 'POST',
    body: JSON.stringify({ name: opts.lineName }),
  })) as { id?: unknown; name?: unknown; joinUrl?: unknown } | undefined;

  if (!line || typeof line.id !== 'string') {
    throw new IntercomManagerError('intercom-manager returned no line id');
  }

  return {
    id: line.id,
    productionId,
    name: typeof line.name === 'string' ? line.name : opts.lineName,
    ...(typeof line.joinUrl === 'string' ? { joinUrl: line.joinUrl } : {}),
  };
}

/**
 * Tear down the intercom production grouping (and all its lines) for an Open
 * Live production. Best-effort — teardown rides the production lifecycle and
 * must not block deactivation, so callers ignore failures.
 */
export async function teardownIntercomProduction(intercomProductionId: string): Promise<void> {
  await request(`/production/${encodeURIComponent(intercomProductionId)}`, { method: 'DELETE' });
}
