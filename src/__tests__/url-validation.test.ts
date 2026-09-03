import { describe, it, expect } from 'vitest';
import { graphicUrl, httpUrlOnly, srtUrl, isPrivateHost } from '../lib/url-validation.js';

describe('graphicUrl', () => {
  it('accepts https:// URLs', () => {
    expect(() => graphicUrl('https://example.com/overlay.png')).not.toThrow();
  });

  it('accepts http:// URLs', () => {
    expect(() => graphicUrl('http://example.com/overlay')).not.toThrow();
  });

  it('accepts data:image/png URIs', () => {
    expect(() => graphicUrl('data:image/png;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/jpeg URIs', () => {
    expect(() => graphicUrl('data:image/jpeg;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/gif URIs', () => {
    expect(() => graphicUrl('data:image/gif;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/webp URIs', () => {
    expect(() => graphicUrl('data:image/webp;base64,abc123')).not.toThrow();
  });

  it('rejects data:text/html URIs (JS execution risk in CEF)', () => {
    expect(() =>
      graphicUrl('data:text/html,<html><script>alert(1)</script></html>')
    ).toThrow();
  });

  it('rejects data:text/html with encoded payload', () => {
    expect(() =>
      graphicUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')
    ).toThrow();
  });

  it('rejects file:// URLs', () => {
    expect(() => graphicUrl('file:///etc/passwd')).toThrow();
  });

  it('rejects javascript: URLs', () => {
    expect(() => graphicUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects data:application/* URIs', () => {
    expect(() => graphicUrl('data:application/json,{}')).toThrow();
  });

  it('rejects data:text/plain URIs', () => {
    expect(() => graphicUrl('data:text/plain,hello')).toThrow();
  });
});

describe('httpUrlOnly', () => {
  it('accepts https:// URLs', () => {
    expect(() => httpUrlOnly('https://example.com')).not.toThrow();
  });

  it('accepts http:// URLs', () => {
    expect(() => httpUrlOnly('http://example.com')).not.toThrow();
  });

  it('rejects ftp:// URLs', () => {
    expect(() => httpUrlOnly('ftp://example.com')).toThrow();
  });

  it('rejects invalid URLs', () => {
    expect(() => httpUrlOnly('not-a-url')).toThrow();
  });

  it('rejects private/loopback IP literals (SSRF)', () => {
    expect(() => httpUrlOnly('http://127.0.0.1/')).toThrow();
    expect(() => httpUrlOnly('http://10.0.0.1/')).toThrow();
    expect(() => httpUrlOnly('http://169.254.169.254/')).toThrow(); // AWS/GCP IMDS
  });

  it('rejects IPv4-mapped IPv6 literals that resolve to a private address', () => {
    // A bare IPv4 regex would miss these — the address is only private once the
    // embedded IPv4 is evaluated. See isPrivateHost's ::ffff: handling.
    expect(() => httpUrlOnly('http://[::ffff:169.254.169.254]/')).toThrow();
    expect(() => httpUrlOnly('http://[::ffff:127.0.0.1]/')).toThrow();
    expect(() => httpUrlOnly('http://[::ffff:10.0.0.1]/')).toThrow();
  });

  it('rejects well-known SSRF hostnames not caught by IP-literal checks', () => {
    expect(() => httpUrlOnly('http://localhost/')).toThrow();
    expect(() => httpUrlOnly('http://metadata.google.internal/')).toThrow();
  });

  it('accepts a public hostname that happens to contain a private-looking substring', () => {
    expect(() => httpUrlOnly('https://10.0.0.1.example.com/')).not.toThrow();
  });
});

describe('isPrivateHost', () => {
  it('flags IPv4 loopback (127/8)', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('127.255.255.254')).toBe(true);
  });

  it('flags IPv4 private ranges (10/8, 172.16/12, 192.168/16)', () => {
    expect(isPrivateHost('10.0.0.1')).toBe(true);
    expect(isPrivateHost('172.16.0.1')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('192.168.1.1')).toBe(true);
  });

  it('flags IPv4 link-local (169.254/16) and 0.0.0.0/8', () => {
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
  });

  it('flags IPv6 loopback, link-local (fe80::/10), and ULA (fc00::/7)', () => {
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
    expect(isPrivateHost('fe80::1')).toBe(true);
    expect(isPrivateHost('fc00::1')).toBe(true);
    expect(isPrivateHost('fd12:3456::1')).toBe(true);
  });

  it('flags IPv4-mapped IPv6 for private embedded addresses (dotted form)', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
  });

  it('flags IPv4-mapped IPv6 for private embedded addresses (hex-hextet form)', () => {
    // The WHATWG URL parser normalizes a bracketed literal to this form —
    // e.g. new URL('http://[::ffff:169.254.169.254]/').hostname is
    // '[::ffff:a9fe:a9fe]', not the dotted form.
    expect(isPrivateHost('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254 (AWS/GCP IMDS)
    expect(isPrivateHost('::ffff:7f00:1')).toBe(true); // 127.0.0.1
    expect(isPrivateHost('::ffff:a00:1')).toBe(true); // 10.0.0.1
  });

  it('does not flag public IPv4/IPv6 addresses', () => {
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('1.1.1.1')).toBe(false);
    expect(isPrivateHost('172.15.0.1')).toBe(false); // just below 172.16/12
    expect(isPrivateHost('172.32.0.1')).toBe(false); // just above 172.16/12
    expect(isPrivateHost('2606:4700:4700::1111')).toBe(false);
    expect(isPrivateHost('::ffff:8.8.8.8')).toBe(false);
  });

  it('does not flag public DNS hostnames', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('srt.example.org')).toBe(false);
  });

  it('does not flag empty host (listener form)', () => {
    expect(isPrivateHost('')).toBe(false);
  });
});

describe('srtUrl', () => {
  it('accepts valid srt:// URLs', () => {
    expect(() => srtUrl('srt://example.com:9000')).not.toThrow();
  });

  it('accepts the hostless listener form (srt://:PORT)', () => {
    expect(() => srtUrl('srt://:6000')).not.toThrow();
    expect(() => srtUrl('srt://:6000?mode=listener')).not.toThrow();
  });

  it('accepts a public host', () => {
    expect(() => srtUrl('srt://198.51.100.5:9000?mode=caller')).not.toThrow();
  });

  it('rejects non-srt URLs', () => {
    expect(() => srtUrl('http://example.com')).toThrow();
  });

  it('rejects private/loopback IPv4 hosts', () => {
    expect(() => srtUrl('srt://127.0.0.1:9999?mode=caller')).toThrow(/private|loopback/i);
    expect(() => srtUrl('srt://10.0.0.1:5005')).toThrow(/private|loopback/i);
    expect(() => srtUrl('srt://192.168.1.10:5005')).toThrow(/private|loopback/i);
    expect(() => srtUrl('srt://169.254.169.254:80')).toThrow(/private|loopback/i);
  });

  it('rejects IPv6 loopback and ULA hosts', () => {
    expect(() => srtUrl('srt://[::1]:9000')).toThrow(/private|loopback/i);
    expect(() => srtUrl('srt://[fc00::1]:9000')).toThrow(/private|loopback/i);
  });

  it('accepts safe query params', () => {
    expect(() => srtUrl('srt://example.com:9999?passphrase=abc123&mode=caller')).not.toThrow();
  });

  it('rejects CR/LF injection in the query string', () => {
    expect(() => srtUrl('srt://example.com:9999?x=a\r\ninjected=1')).toThrow('Control characters not allowed');
    expect(() => srtUrl('srt://example.com:9999?x=a\ninjected')).toThrow('Control characters not allowed');
  });

  it('rejects a NUL byte', () => {
    expect(() => srtUrl('srt://example.com:9999?x=\x00')).toThrow('Control characters not allowed');
  });

  it('rejects a URL exceeding the max length', () => {
    expect(() => srtUrl('srt://example.com:9999?' + 'a'.repeat(600))).toThrow('SRT URL too long');
  });

  it('rejects backslash and quotes in the query string', () => {
    expect(() => srtUrl('srt://example.com:9999?x=a\\b')).toThrow('Invalid SRT URL format');
    expect(() => srtUrl('srt://example.com:9999?x="evil"')).toThrow('Invalid SRT URL format');
  });

  it('rejects a URL with no port', () => {
    expect(() => srtUrl('srt://example.com')).toThrow('Invalid SRT URL format');
  });
});
