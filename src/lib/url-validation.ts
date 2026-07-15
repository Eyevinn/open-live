/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: http/https + non-empty host + no private/link-local/metadata IPs (#65)
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only
 */

/**
 * True if hostname is loopback, link-local, private RFC1918, CGNAT, or AWS IMDS.
 * Hostname may be a literal IPv4/IPv6 address or a blocked special name.
 */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === 'metadata' ||
    h === 'metadata.google.internal' ||
    h === '0.0.0.0'
  ) {
    return true;
  }

  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // invalid → reject
    }
    const [a, b] = parts as [number, number, number, number];
    if (a === 0) return true;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + IMDS
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  }

  // IPv6 literal (common forms)
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    // IPv4-mapped ::ffff:127.0.0.1 etc.
    const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped?.[1] && isBlockedHostname(mapped[1])) return true;
  }

  return false;
}

/**
 * Throws if the URL is not a safe http/https URL (no private SSRF targets).
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
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error('URL host is not allowed (private, loopback, or link-local address)');
  }
}

// #70: ban data:text/html (JS in Strom cefsrc). Raster images only.
const ALLOWED_DATA_MIME = /^data:image\/(png|jpeg|gif|webp)[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https (public hosts only), or data:image/(png|jpeg|gif|webp).
 * Rejects: data:text/html, private IPs, file://, javascript:, etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:image/(png|jpeg|gif|webp) URIs are allowed for graphics');
    }
    return;
  }
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
