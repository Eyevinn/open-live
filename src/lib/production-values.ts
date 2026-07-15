/**
 * Validate production.values before they reach Strom block properties.
 * @see https://github.com/Eyevinn/open-live/issues/88
 */

export const RESOLUTION_RE = /^\d{3,5}x\d{3,5}$/;
export const FRAMERATE_RE = /^\d{1,3}(?:\/\d{1,3})?$/;
export const CLOCK_TYPES = new Set(['ntp', 'gst', 'system']);

/** Keys we forward / interpret from production.values */
export const KNOWN_VALUE_KEYS = new Set([
  'pgm_resolution',
  'pgm_framerate',
  'multiview_resolution',
  'multiview_framerate',
  'bitrate',
  'multiview_bitrate',
  'clock',
  'num_aux_buses',
  'num_groups',
  'mix_latency',
  'num_pips',
  'swap_pvw_pgm',
]);

export type ProductionValues = Record<string, string | number | boolean>;

export function validateProductionValues(
  values: ProductionValues,
): { ok: true; values: ProductionValues } | { ok: false; error: string } {
  const out: ProductionValues = {};

  for (const [key, raw] of Object.entries(values)) {
    if (!KNOWN_VALUE_KEYS.has(key)) {
      return { ok: false, error: `Unknown production value key: ${key}` };
    }

    if (key === 'pgm_resolution' || key === 'multiview_resolution') {
      if (typeof raw !== 'string' || !RESOLUTION_RE.test(raw)) {
        return { ok: false, error: `Invalid ${key}: expected e.g. 1280x720` };
      }
      out[key] = raw;
      continue;
    }

    if (key === 'pgm_framerate' || key === 'multiview_framerate') {
      if (typeof raw !== 'string' || !FRAMERATE_RE.test(raw)) {
        return { ok: false, error: `Invalid ${key}: expected e.g. 30 or 30000/1001` };
      }
      out[key] = raw;
      continue;
    }

    if (key === 'clock') {
      if (typeof raw !== 'string' || !CLOCK_TYPES.has(raw)) {
        return {
          ok: false,
          error: `Invalid clock type: ${String(raw)} (allowed: ntp, gst, system)`,
        };
      }
      out[key] = raw;
      continue;
    }

    if (
      key === 'bitrate' ||
      key === 'multiview_bitrate' ||
      key === 'num_aux_buses' ||
      key === 'num_groups' ||
      key === 'mix_latency' ||
      key === 'num_pips'
    ) {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) {
        return { ok: false, error: `Invalid ${key}: expected non-negative number` };
      }
      out[key] = n;
      continue;
    }

    if (key === 'swap_pvw_pgm') {
      out[key] = raw === true || raw === 'true';
      continue;
    }
  }

  return { ok: true, values: out };
}
