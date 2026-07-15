/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes; reject private/loopback hosts
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only; reject private/loopback hosts (listener :port OK)
 */

/**
 * Returns true if hostname targets private, loopback, link-local, or metadata ranges.
 * Covers IPv4 private, IPv6 ULA (fc00::/7), link-local, IPv4-mapped IPv6, and localhost.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1') {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hex)
  const v4Mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4Mapped) return isPrivateHost(v4Mapped[1]!);
  if (/^::ffff:/i.test(host)) {
    // hex form ::ffff:7f00:1 → treat as private (mapped space)
    return true;
  }

  // IPv6: loopback already handled; ULA fc00::/7, link-local fe80::/10
  if (host.includes(':')) {
    if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fec0:')) return true;
    // fc00::/7 → first hextet 0xfc00–0xfdff
    const first = host.split(':')[0] ?? '';
    if (/^f[cd][0-9a-f]{0,2}$/i.test(first) || first.toLowerCase() === 'fc' || first.toLowerCase() === 'fd') {
      return true;
    }
    // broader: fc* / fd* prefix (ULA)
    if (/^f[cd]/i.test(first)) return true;
    return false;
  }

  // IPv4 dotted
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    // bare hostname "localhost" handled; other names allowed (public DNS)
    return false;
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // invalid → reject
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata path often 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT optional harden
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
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('URL must not target private, loopback, or link-local addresses');
  }
}

const ALLOWED_DATA_MIME = /^data:(text\/html|image\/(png|jpeg|gif|webp))[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs, data:text/html (inline HTML overlays rendered by Strom's headless browser),
 *          or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: file://, javascript:, data:application/*, etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:text/html or data:image/(png|jpeg|gif|webp) URIs are allowed for graphics');
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
 * Listener-mode URIs (srt://:PORT) remain allowed; private/loopback hosts are rejected.
 */
export function srtUrl(url: string): void {
  if (!url.startsWith('srt://')) {
    throw new Error('Only srt:// URLs are allowed');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('SRT URL contains disallowed characters');
  }

  // Parse host via WHATWG URL by rewriting scheme (srt://:9000 stays empty host)
  let hostname: string;
  try {
    hostname = new URL(url.replace(/^srt:\/\//i, 'http://')).hostname;
  } catch {
    throw new Error('Invalid SRT URL');
  }
  // Empty host = listener bind-all (srt://:6000?mode=listener) — allow
  if (hostname && isPrivateHost(hostname)) {
    throw new Error('SRT URL must not target private, loopback, or link-local addresses');
  }
}
