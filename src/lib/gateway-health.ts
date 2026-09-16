/**
 * Compute-on-read gateway health derivation (issue #263,
 * `docs/specs/studio-gateways.md` §"Health derivation").
 *
 * Health is NEVER persisted on the `GatewayDoc` — it is derived from
 * `lastSeenAt` on every read, the same "compute-on-read" approach OL-4 uses for
 * output health. This keeps every read truthful without a background writer to
 * flip a persisted flag. The vocabulary is the OL-4 `healthy | down | unknown`
 * — there is deliberately no `degraded` value.
 */

import type { GatewayDoc, GatewayHealth, GatewayInputStatus } from '../db/types.js';
import { config } from '../config.js';

/**
 * Derive a gateway's health from its last-seen time.
 *  - `unknown` — never contacted (`lastSeenAt` is null).
 *  - `healthy` — last heartbeat within `GATEWAY_DOWN_AFTER_SECONDS`.
 *  - `down`    — last heartbeat older than the threshold.
 */
export function deriveGatewayHealth(
  lastSeenAt: string | null | undefined,
  now: Date = new Date(),
): GatewayHealth {
  if (!lastSeenAt) return 'unknown';
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return 'unknown';
  const ageSeconds = (now.getTime() - seen) / 1000;
  return ageSeconds <= config.gatewayDownAfterSeconds ? 'healthy' : 'down';
}

/** The gateway shape returned by the REST read endpoints (never includes the token or hash). */
export interface GatewayApi {
  id: string;
  name: string;
  health: GatewayHealth;
  lastSeenAt: string | null;
  host?: string;
  stromVersion?: string;
  deviceCount?: number;
  streamingCount?: number;
  inputs?: GatewayInputStatus[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Project a stored `GatewayDoc` to its API representation: strip the internal
 * CouchDB/type/token-hash fields and attach the compute-on-read `health`.
 */
export function gatewayToApi(doc: GatewayDoc, now: Date = new Date()): GatewayApi {
  const { _id, _rev, type, tokenHash, lastSeenAt, ...rest } = doc;
  void _rev;
  void type;
  void tokenHash;
  return {
    id: _id,
    ...rest,
    lastSeenAt,
    health: deriveGatewayHealth(lastSeenAt, now),
  };
}
