/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes with no private-IP targets
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only; reject private/internal hosts (listener form allowed)
 */

/**
 * Returns true if the given host is an IP literal in a private, loopback,
 * link-local, or internal range that must not be reachable via SSRF.
 *
 * Covered ranges:
 * - IPv4: 10/8, 172.16/12, 192.168/16, 127/8 (loopback), 169.254/16 (link-local),
 *   0.0.0.0
 * - IPv6: ::1 (loopback), fe80::/10 (link-local), fc00::/7 (unique-local)
 * - IPv4-mapped IPv6: ::ffff:a.b.c.d (evaluated as the embedded IPv4 address) —
 *   in BOTH forms the WHATWG URL parser can produce: dotted-decimal
 *   (::ffff:127.0.0.1) and the two-hextet hex form it normalizes bracketed
 *   literals to (`new URL('http://[::ffff:169.254.169.254]/').hostname` is
 *   `[::ffff:a9fe:a9fe]`, not the dotted form) — checking only the former
 *   lets a bracketed IPv4-mapped literal sail straight through.
 *
 * Non-IP hostnames (public DNS names) are NOT flagged here — DNS resolution is out
 * of scope for this synchronous validator; this blocks the direct-IP SSRF vector.
 */
export function isPrivateHost(hostname: string): boolean {
  // Strip surrounding brackets from IPv6 literals and normalise case.
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;

  // IPv4-mapped IPv6, dotted-decimal form, e.g. ::ffff:127.0.0.1.
  const mappedDotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    return isPrivateIPv4(mappedDotted[1]!);
  }

  // IPv4-mapped IPv6, hex-hextet form, e.g. ::ffff:a9fe:a9fe (== 169.254.169.254).
  // This is the form the URL parser actually produces for a bracketed literal.
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const dotted = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
    return isPrivateIPv4(dotted);
  }

  if (host.includes(':')) {
    return isPrivateIPv6(host);
  }

  return isPrivateIPv4(host);
}

/**
 * True if `host` is a dotted-quad IPv4 literal in a private/loopback/link-local range.
 * Returns false for anything that is not a valid IPv4 literal (e.g. DNS names).
 */
function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * True if `host` is an IPv6 literal in the loopback, link-local (fe80::/10),
 * or unique-local (fc00::/7) ranges. `host` is expected lower-cased and unbracketed.
 */
function isPrivateIPv6(host: string): boolean {
  if (host === '::1') return true; // loopback
  if (host === '::') return true; // unspecified
  const first = host.split(':')[0] ?? '';
  // Unique-local fc00::/7 -> first hextet in fc00..fdff.
  if (/^f[cd][0-9a-f]{0,2}$/.test(first)) return true;
  // Link-local fe80::/10 -> first hextet in fe80..febf.
  if (/^fe[89ab][0-9a-f]$/.test(first)) return true;
  return false;
}

/**
 * Hostnames that resolve to loopback/link-local/internal addresses but are not
 * themselves IP literals, so `isPrivateHost()` cannot catch them.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal', // GCP metadata endpoint
]);

/**
 * Throws if the URL is not a safe http/https URL.
 * Rejects private/loopback/link-local/internal IP literals (via `isPrivateHost`,
 * which also catches IPv4-mapped IPv6 such as ::ffff:169.254.169.254 — the AWS
 * IMDS bypass an IPv4-only regex would miss) and well-known SSRF hostnames.
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
  // Strip surrounding brackets from IPv6 literals (e.g. [::1] → ::1)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateHost(hostname)) {
    throw new Error(`URL hostname "${hostname}" is in a private/reserved IP range — SSRF blocked`);
  }
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`URL hostname "${hostname}" is not allowed — SSRF blocked`);
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
  // Otherwise must be a safe http/https URL with no private IP
  httpUrlOnly(url);
}

// Strict allowlist: srt://<host>:<port>[?params] or srt://:<port>[?params] (bind all interfaces)
// Host: alphanumeric, dots, hyphens, or IPv6 bracketed address
// Port: 1–5 digits
// Query: alphanumeric and safe URL chars only — no control characters, no quotes, no backslash
const SRT_URL_RE = /^srt:\/\/(([A-Za-z0-9.\-]|\[[0-9a-fA-F:]+\])*:\d{1,5})(\?[A-Za-z0-9._\-=&%+]+)?$/;

/**
 * Throws if the value is not a valid SRT URL.
 *
 * The hostless listener form (`srt://:PORT`, binds all interfaces) is allowed.
 * URLs whose host is a private/loopback/link-local/internal IP are rejected to
 * prevent SSRF from the GStreamer pipeline to internal services.
 */
export function srtUrl(url: string): void {
  if (url.length > 512) {
    throw new Error('SRT URL too long');
  }
  // Reject control characters before regex (covers CR, LF, tab, NUL, etc.)
  if (/[\x00-\x1f\x7f]/.test(url)) {
    throw new Error('Control characters not allowed in SRT URL');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('Invalid SRT URL format — expected srt://host:port or srt://:port with safe query params');
  }

  // Extract the authority (host[:port]) from srt://<authority>[/path][?query].
  // The listener form `srt://:6000` has an empty host and is allowed as-is; the
  // WHATWG URL parser rejects the equivalent `http://:6000`, so parse manually.
  const authority = url.slice('srt://'.length).split(/[/?#]/, 1)[0] ?? '';

  let hostname = '';
  const bracketed = authority.match(/^\[([^\]]*)\](?::\d+)?$/); // IPv6 literal, e.g. [::1]:9000
  if (bracketed) {
    hostname = bracketed[1]!;
  } else {
    // Host is everything up to the final ":port" (if any).
    hostname = authority.replace(/:\d+$/, '');
  }

  if (hostname && isPrivateHost(hostname)) {
    throw new Error('SRT URL must not target private, loopback, or link-local addresses');
  }
}
