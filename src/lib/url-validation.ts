/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes
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
 * - IPv4-mapped IPv6: ::ffff:a.b.c.d (evaluated as the embedded IPv4 address)
 *
 * Non-IP hostnames (public DNS names) are NOT flagged here — DNS resolution is out
 * of scope for this synchronous validator; this blocks the direct-IP SSRF vector.
 */
export function isPrivateHost(hostname: string): boolean {
  // Strip surrounding brackets from IPv6 literals and normalise case.
  const host = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;

  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1 — evaluate the embedded IPv4.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    return isPrivateIPv4(mapped[1]!);
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
 *
 * The hostless listener form (`srt://:PORT`, binds all interfaces) is allowed.
 * URLs whose host is a private/loopback/link-local/internal IP are rejected to
 * prevent SSRF from the GStreamer pipeline to internal services.
 */
export function srtUrl(url: string): void {
  if (!url.startsWith('srt://')) {
    throw new Error('Only srt:// URLs are allowed');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('SRT URL contains disallowed characters');
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
