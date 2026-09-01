/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only
 */

/**
 * Throws if the URL is not a safe http/https URL.
 */
export function httpUrlOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http/https allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('URL must have a hostname');
  }
}

const ALLOWED_DATA_MIME = /^data:image\/(png|jpeg|gif|webp)[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: data:text/html (JS execution risk in CEF), file://, javascript:, data:application/*, etc.
 * HTML overlay sources must be served from a trusted https:// URL, not inline data URIs.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:image/(png|jpeg|gif|webp) URIs are allowed for graphics; HTML overlays must use an https:// URL');
    }
    return;
  }
  // Otherwise must be a safe http/https URL
  httpUrlOnly(url);
}

// srt://<host>:<port>[?params] or srt://:<port>[?params] (empty host = bind all interfaces)
const SRT_URL_RE = /^srt:\/\/[^!; ]*$/i;

/**
 * Throws if the value is not a valid SRT URL.
 */
export function srtUrl(url: string): void {
  if (!url.startsWith('srt://')) {
    throw new Error('Only srt:// URLs are allowed');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('SRT URL contains disallowed characters');
  }
}
