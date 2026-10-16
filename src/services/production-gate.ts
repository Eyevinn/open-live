/**
 * Zero-balance start gate (issue #523, Part of open-live-site#198).
 *
 * Rule (open-live#500 point 3): a running production is NEVER stopped because the
 * balance reaches zero or goes negative. A NEW production cannot be started while
 * the workspace balance is zero or negative, until the tenant tops up.
 *
 * This module is only consulted at production start (`POST .../activate`). It has
 * no hook into any running production: nothing here stops, pauses or degrades a
 * live flow, and nothing may be added that does.
 *
 * Applies only to metered instances (`GPU_POOL` set — the shared and the alternate
 * Strom). Self-hosted and bring-your-own-Strom instances are not metered
 * (open-live#500 AC5, BYO usage is zero-rated) and are never gated.
 *
 * Fails open: if the balance cannot be read, the start is allowed and the failure
 * is logged and counted, so a release check can tell a working gate from one that
 * silently fails open.
 *
 * Balance source: the money-manager `GET /mytokencount` (`x-pat-jwt` bearer PAT),
 * the same call the Open Live site funnel uses. `remainingTokens` is the
 * available balance minus consumption and can be negative.
 */

import type { FastifyBaseLogger } from 'fastify';
import { config, isGpuMeteringEnabled } from '../config.js';

/** Fixed money-manager endpoint (never caller-supplied, anti-SSRF). */
export const TOKEN_COUNT_URL = 'https://money.svc.prod.osaas.io/mytokencount';

/**
 * Ceiling for the balance lookup on the start path. A timeout fails open, so it
 * only costs latency. Measurement (2026-10-15, last 6 h): platform ingress access
 * log on prod-se (Elastx Loki, {namespace="osaas", app="ingress-nginx"}) for
 * money.svc.prod.osaas.io GET /mytokencount: 25 successful requests, request_time
 * p50 0.14 s, max 0.505 s (small sample, the endpoint is called rarely). 2000 ms is
 * about four times the observed maximum. Approved by birme on open-live#523.
 */
export const LOOKUP_TIMEOUT_MS = 2000;

/** Customer-facing refusal text. Hours wording only, no credit-unit word. */
export const OUT_OF_HOURS_MESSAGE =
  'Your workspace has no production hours left. Buy extra hours to start a new production. Productions that are already running are not affected.';

let lookupErrors = 0;
let refusals = 0;

export type GateDecision = { allowed: true } | { allowed: false; message: string };

/** Test helper: reset the in-memory counters. */
export function resetProductionGateCounters(): void {
  lookupErrors = 0;
  refusals = 0;
}

export function getProductionGateCounters(): { lookupErrors: number; refusals: number } {
  return { lookupErrors, refusals };
}

/** Throws on any failure to obtain a usable numeric balance. */
async function fetchRemainingBalance(pat: string): Promise<number> {
  const res = await fetch(TOKEN_COUNT_URL, {
    headers: { 'x-pat-jwt': `Bearer ${pat}`, accept: 'application/json' },
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`balance lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { remainingTokens?: unknown };
  const remaining = body?.remainingTokens;
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    throw new Error('balance lookup returned no usable balance');
  }
  return remaining;
}

/**
 * Decide whether a new production may start. Never throws.
 */
export async function checkProductionStartAllowed(log: FastifyBaseLogger): Promise<GateDecision> {
  if (!isGpuMeteringEnabled()) return { allowed: true };

  try {
    if (!config.oscPat) throw new Error('no OSC access token configured');
    const remaining = await fetchRemainingBalance(config.oscPat);
    if (remaining <= 0) {
      refusals++;
      log.warn({ remaining }, '[production-gate] Production start refused: balance is zero or negative');
      return { allowed: false, message: OUT_OF_HOURS_MESSAGE };
    }
    return { allowed: true };
  } catch (err) {
    lookupErrors++;
    log.error({ err }, '[production-gate] Balance lookup failed — allowing production start (fail open)');
    return { allowed: true };
  }
}

/** Prometheus lines for the gate counters. Empty when the instance is unmetered. */
export function renderProductionGateMetrics(): string[] {
  if (!isGpuMeteringEnabled()) return [];
  return [
    '# HELP osc_production_gate_lookup_errors_total Balance lookups that failed, letting a production start (fail open).',
    '# TYPE osc_production_gate_lookup_errors_total counter',
    `osc_production_gate_lookup_errors_total ${lookupErrors}`,
    '# HELP osc_production_gate_refusals_total Production starts refused because the balance was zero or negative.',
    '# TYPE osc_production_gate_refusals_total counter',
    `osc_production_gate_refusals_total ${refusals}`,
  ];
}
