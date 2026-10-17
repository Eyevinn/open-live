/**
 * Platform-hosted Strom detection and default shared-GPU metering
 * (issue #537, part of #526; ADR-005, docs/specs/shared-gpu-usage-metering.md).
 *
 * An OSC-managed Open Live instance pointed at the platform's shared Strom is
 * metered by default, with no `GPU_POOL` set on the instance, once the platform
 * switch below is on. Everything else (self-hosted, bring-your-own Strom, a
 * tenant's own Strom instance on OSC) stays at zero (open-live#500 AC5).
 *
 * Two signals are required, and neither can be set by a tenant to opt out:
 * - OSC-managed: `OSC_HOSTNAME` is non-empty. It is injected by
 *   `osaas-lib-orchestrator` (`envVarRefs`, a fieldRef to the instance url
 *   annotation) after the service options, and no published
 *   `eyevinn-open-live` option maps to it.
 * - Platform-hosted Strom: `STROM_URL` is `https`, has no userinfo, its host
 *   is a single `strom-se-stoNN` label directly under `osaas.io`, and its port
 *   is in {@link PLATFORM_STROM_PORTS}. No suffix or wildcard match on the OSC
 *   instance domain: a tenant's own Strom lives under a multi-label service
 *   domain and must not match.
 *
 * Explicit `GPU_POOL` / `GPU_CLASS` env values always override the defaults,
 * and `GPU_POOL` alone still enables metering anywhere (the existing opt-in).
 * There is deliberately no tenant off switch.
 *
 * This module is pure (no env reads): `src/config.ts` reads the env and calls
 * {@link resolveGpuMetering}.
 */

/**
 * Platform switch for default metering. Shipped `false`: with it off, metering
 * and the zero-balance start gate stay on only where `GPU_POOL` is set, so
 * merging this changes nothing on any managed instance.
 *
 * DO NOT CHANGE in any PR other than the human flip PR that is step 2a of
 * Eyevinn/open-live-site#205 (opened and merged by a person, never by
 * automation). Flipping it starts production-hour charging and zero-balance
 * gating on every managed shared-Strom instance at its next restart.
 */
export const PLATFORM_DEFAULT_METERING_ENABLED = false;

/** Host of a platform-hosted shared Strom box: one label directly under `osaas.io`. */
export const PLATFORM_STROM_HOST_RE = /^strom-se-sto\d{2}\.osaas\.io$/i;

/**
 * Strom ports the funnel hands to tenants and that are metered. `8080` is the
 * shared Strom. `8082` (alternate, internal) and `8084` (testbed) stay at zero,
 * and so does no port / `:443` (nothing listens there).
 */
export const PLATFORM_STROM_PORTS: readonly string[] = ['8080'];

/** Class used for a platform-default match. */
const PLATFORM_GPU_CLASS = 'shared';

export interface ResolveGpuMeteringInput {
  /** The platform switch; pass {@link PLATFORM_DEFAULT_METERING_ENABLED}. */
  enabled: boolean;
  /** Trimmed `GPU_POOL` env value, or undefined when unset/empty. */
  gpuPoolEnv?: string;
  /** Trimmed `GPU_CLASS` env value, or undefined when unset/empty. */
  gpuClassEnv?: string;
  /** Trimmed `OSC_HOSTNAME` env value, or undefined when unset/empty. */
  oscHostname?: string;
  /** The configured `STROM_URL`. */
  stromUrl?: string;
}

export interface GpuMeteringResolution {
  pool: string;
  class: string;
  /** `env` when `GPU_POOL` is set explicitly, else `platform-default`. */
  source: 'env' | 'platform-default';
}

/**
 * Returns the pool label (host label minus `strom-`, e.g. `se-sto01`) when
 * `stromUrl` is a platform-hosted shared Strom endpoint, else undefined.
 * A parse failure is no match. Path and trailing slash are ignored.
 */
export function platformStromPool(stromUrl: string | undefined): string | undefined {
  if (!stromUrl) return undefined;
  let url: URL;
  try {
    url = new URL(stromUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (!PLATFORM_STROM_HOST_RE.test(url.hostname)) return undefined;
  // WHATWG URL normalises a default port (`:443` for https) to '', so "no
  // port" and ":443" both fall through to the list check and miss.
  if (!PLATFORM_STROM_PORTS.includes(url.port)) return undefined;
  const label = url.hostname.toLowerCase().split('.')[0]!;
  return label.slice('strom-'.length);
}

/**
 * Resolve the metering pool/class for this instance. Returns undefined when
 * metering is off (no explicit `GPU_POOL` and no platform-default match).
 */
export function resolveGpuMetering(input: ResolveGpuMeteringInput): GpuMeteringResolution | undefined {
  const { enabled, gpuPoolEnv, gpuClassEnv, oscHostname, stromUrl } = input;
  if (gpuPoolEnv) {
    return { pool: gpuPoolEnv, class: gpuClassEnv ?? PLATFORM_GPU_CLASS, source: 'env' };
  }
  if (!enabled || !oscHostname) return undefined;
  const pool = platformStromPool(stromUrl);
  if (!pool) return undefined;
  return { pool, class: gpuClassEnv ?? PLATFORM_GPU_CLASS, source: 'platform-default' };
}
