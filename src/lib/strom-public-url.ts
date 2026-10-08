/**
 * Strom URLs as seen by browsers vs. by this server.
 *
 * `STROM_URL` is where this server reaches Strom; `STROM_PUBLIC_URL`, when
 * set, is where browsers reach it. URLs stored for the studio are built on the
 * public base, and browser-supplied URLs (the WHEP proxy `target`) are mapped
 * back to `STROM_URL` before this server fetches them.
 */
import { config } from '../config.js';

/** Base URL for Strom URLs handed to browsers: `STROM_PUBLIC_URL`, else `STROM_URL`. */
export function stromBrowserBaseUrl(): string {
  return config.stromPublicUrl ?? config.stromUrl;
}

/**
 * Maps a URL under `STROM_PUBLIC_URL` to the same path under `STROM_URL`.
 * Any other URL is returned unchanged, so callers still validate the result
 * against `STROM_URL`.
 */
export function toInternalStromUrl(url: string): string {
  const publicBase = config.stromPublicUrl;
  if (!publicBase || !url.startsWith(publicBase)) return url;
  const rest = url.slice(publicBase.length);
  if (rest !== '' && !rest.startsWith('/') && !rest.startsWith('?')) return url;
  return config.stromUrl.replace(/\/+$/, '') + rest;
}
