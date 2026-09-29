/**
 * RTMP multi-destination presets + credential validation (spec:
 * rtmp-multi-destination.md, ADR-004).
 *
 * The preset table maps a named platform → its RTMP(S) ingest-URL template. It
 * is STATIC server-side config, holds no secret, and is never user-editable in
 * v1. A named preset resolves its `ingestUrl` ONLY from this table — never from
 * client input — so a client cannot repoint a "youtube" destination at an
 * attacker host. The `'custom'` platform instead carries an operator-supplied
 * `rtmp(s)://` ingest URL, validated for scheme + SSRF at the API boundary.
 *
 * The stream key is appended to the ingest URL only inside the flow generator at
 * activation time, from the decrypted key — never persisted composed, never
 * logged (ADR-004 Decision 3).
 *
 * Encoder defaults per platform are intentionally NOT wired here: the exact
 * `builtin.rtmp_output` encoder-profile property is gated on strom#783 (spec
 * Resolved Decision 4) and unverified, and this module must not invent a Strom
 * field. Encoder defaults land once strom#783 fixes the engine default.
 */

import type { RtmpPlatform } from '../db/types.js';
import { isPrivateHost, BLOCKED_HOSTNAMES } from './url-validation.js';

/** The v1 platform set (ADR-004 Resolved Decision 1). */
export const RTMP_PLATFORMS: readonly RtmpPlatform[] = ['youtube', 'twitch', 'facebook', 'custom'];

/**
 * Static, secret-free ingest-URL table for the named presets. The exact
 * per-platform URLs must be verified live before a real end-to-end publish
 * (Tier 1 in the epic). `'custom'` is deliberately absent — its URL comes from
 * the operator, validated by `validateCustomIngestUrl`.
 */
export const RTMP_PRESETS: Record<Exclude<RtmpPlatform, 'custom'>, { ingestUrl: string }> = {
  youtube: { ingestUrl: 'rtmps://a.rtmp.youtube.com/live2' },
  twitch: { ingestUrl: 'rtmp://live.twitch.tv/app' },
  facebook: { ingestUrl: 'rtmps://live-api-s.facebook.com:443/rtmp' },
};

/** Max accepted stream-key length — a generous cap to bound stored ciphertext. */
export const STREAM_KEY_MAX = 512;
/** Max accepted custom ingest-URL length. */
export const RTMP_URL_MAX = 512;

export function isRtmpPlatform(value: unknown): value is RtmpPlatform {
  return typeof value === 'string' && (RTMP_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Validate an operator-supplied `custom` ingest URL. Throws (→ 400) on any
 * scheme other than rtmp:// / rtmps://, on control chars, on over-length, and
 * on a private/loopback/link-local/internal host (SSRF). Named presets never
 * reach here — their URL comes from the static table.
 */
export function validateCustomIngestUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('custom RTMP destination requires an ingestUrl');
  }
  if (url.length > RTMP_URL_MAX) {
    throw new Error('RTMP ingest URL too long');
  }
  // Reject control characters before parsing (covers CR, LF, tab, NUL, etc.).
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) {
    throw new Error('Control characters not allowed in RTMP ingest URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RTMP ingest URL: ${url}`);
  }
  if (parsed.protocol !== 'rtmp:' && parsed.protocol !== 'rtmps:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only rtmp:// or rtmps:// allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('RTMP ingest URL must have a hostname');
  }
  // Strip surrounding brackets from IPv6 literals (e.g. [::1] → ::1).
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(hostname)) {
    throw new Error(`RTMP ingest URL hostname "${hostname}" is in a private/reserved IP range — SSRF blocked`);
  }
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`RTMP ingest URL hostname "${hostname}" is not allowed — SSRF blocked`);
  }
}

/**
 * Resolve the ingest URL for a create/patch. Named presets resolve from the
 * static table (client input ignored); `'custom'` validates + returns the
 * operator-supplied URL. Throws (→ 400) on an unknown platform or a bad custom
 * URL.
 */
export function resolveIngestUrl(platform: RtmpPlatform, customIngestUrl?: string): string {
  if (platform === 'custom') {
    validateCustomIngestUrl(customIngestUrl ?? '');
    return customIngestUrl as string;
  }
  const preset = RTMP_PRESETS[platform];
  if (!preset) {
    throw new Error(`Unknown RTMP platform "${platform}"`);
  }
  return preset.ingestUrl;
}

/**
 * Validate a raw stream key. Throws (→ 400) on: empty, over length, any control
 * char / whitespace / newline, or an `encv1:` prefix (which would let a caller
 * smuggle a plaintext key past the encrypt-at-rest double-wrap guard — ADR-004
 * security condition 4).
 */
export function validateStreamKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('streamKey must be a non-empty string');
  }
  if (key.length > STREAM_KEY_MAX) {
    throw new Error(`streamKey too long (max ${STREAM_KEY_MAX})`);
  }
  // Reject any whitespace/newline/control char — a real platform stream key has
  // none, and a newline would enable log/URL injection.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(key)) {
    throw new Error('streamKey must not contain whitespace or control characters');
  }
  if (key.startsWith('encv1:')) {
    throw new Error('streamKey must not begin with the reserved "encv1:" prefix');
  }
}

/**
 * Compose the RTMP publish URL from an ingest URL and a decrypted stream key.
 * Used ONLY at flow-generation time; the result is never persisted or logged.
 */
export function composeRtmpUrl(ingestUrl: string, streamKey: string): string {
  return `${ingestUrl.replace(/\/+$/, '')}/${streamKey}`;
}
