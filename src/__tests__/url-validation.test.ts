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

  it('flags IPv4-mapped IPv6 for private embedded addresses', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateHost('::ffff:10.0.0.1')).toBe(true);
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
});
