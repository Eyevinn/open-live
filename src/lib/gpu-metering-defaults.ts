/**
 * Platform-hosted Strom detection and default shared-GPU metering
 * (issues #537 and #547, part of #526; ADR-005 Amendments 1 and 2,
 * docs/specs/shared-gpu-usage-metering.md).
 *
 * An OSC-managed Open Live instance pointed at the platform's shared Strom is
 * always metered, with no `GPU_POOL` set on the instance. There is no switch:
 * nothing a tenant or an operator sets on the instance turns it off (#547).
 * Everything else (self-hosted, bring-your-own Strom, a tenant's own Strom
 * instance on OSC, the alternate Strom) stays at zero (open-live#500 AC5).
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
 * `GPU_POOL` is internal operator/test configuration: it overrides the pool
 * label and enables metering anywhere (e.g. a non-platform test instance). It
 * can never turn metering off. On a platform-hosted Strom the class is always
 * `shared` (#547): `GPU_CLASS` is ignored there, so it cannot stop the charge.
 * Off a platform match, `GPU_CLASS` stays a dashboard label.
 *
 * This module is pure (no env reads): `src/config.ts` reads the env and calls
 * {@link resolveGpuMetering}.
 */

/** Host of a platform-hosted shared Strom box: one label directly under `osaas.io`. */
export const PLATFORM_STROM_HOST_RE = /^strom-se-sto\d{2}\.osaas\.io$/i;

/**
 * Strom ports the funnel hands to tenants and that are metered. `8080` is the
 * shared Strom. `8082` (alternate, internal) and `8084` (testbed) stay at zero,
 * and so does no port / `:443` (nothing listens there).
 */
export const PLATFORM_STROM_PORTS: readonly string[] = ['8080'];

/** Class used, and forced, whenever `STROM_URL` is a platform-hosted shared Strom. */
const PLATFORM_GPU_CLASS = 'shared';

export interface ResolveGpuMeteringInput {
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
 *
 * Whenever `stromUrl` is a platform-hosted shared Strom, the class is `shared`
 * on both branches, whatever `GPU_CLASS` says (#547).
 */
export function resolveGpuMetering(input: ResolveGpuMeteringInput): GpuMeteringResolution | undefined {
  const { gpuPoolEnv, gpuClassEnv, oscHostname, stromUrl } = input;
  const platformPool = platformStromPool(stromUrl);
  const gpuClass = platformPool ? PLATFORM_GPU_CLASS : (gpuClassEnv ?? PLATFORM_GPU_CLASS);
  if (gpuPoolEnv) {
    return { pool: gpuPoolEnv, class: gpuClass, source: 'env' };
  }
  if (!oscHostname || !platformPool) return undefined;
  return { pool: platformPool, class: gpuClass, source: 'platform-default' };
}
