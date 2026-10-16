/**
 * SSRF guard for operator-supplied storage-connection endpoints (issue #520,
 * OL-21, ADR-009 Decision 2, spec §5).
 *
 * `storageEndpointHost()` default-denies private/loopback/link-local hosts and
 * relaxes only through the `TRUSTED_STORAGE_HOSTS` allowlist (bare IP / CIDR),
 * reusing the shared `isTrustedHost` matcher. Mirrors the SRT allowlist test
 * matrix (`docs/specs/configurable-srt-private-host-allowlist.md` §6).
 */
import { describe, it, expect } from 'vitest';
import { storageEndpointHost, isTrustedHost } from '../lib/url-validation.js';

describe('storageEndpointHost — default-deny private endpoints', () => {
  it('accepts a public endpoint and normalises host[:port]', () => {
    expect(storageEndpointHost('https://s3.eu-west-1.amazonaws.com')).toBe('s3.eu-west-1.amazonaws.com');
    expect(storageEndpointHost('minio.example.com:9000')).toBe('minio.example.com:9000');
    expect(storageEndpointHost('http://s3.example.com/')).toBe('s3.example.com');
  });

  it('rejects private / loopback / link-local / metadata endpoints when the allowlist is empty', () => {
    expect(() => storageEndpointHost('http://192.168.1.50:9000')).toThrow(/TRUSTED_STORAGE_HOSTS/);
    expect(() => storageEndpointHost('http://10.0.0.5:9000')).toThrow(/TRUSTED_STORAGE_HOSTS/);
    expect(() => storageEndpointHost('http://127.0.0.1:9000')).toThrow(/TRUSTED_STORAGE_HOSTS/);
    expect(() => storageEndpointHost('http://169.254.169.254')).toThrow(/TRUSTED_STORAGE_HOSTS/);
    expect(() => storageEndpointHost('http://localhost:9000')).toThrow(/TRUSTED_STORAGE_HOSTS/);
    expect(() => storageEndpointHost('http://[::1]:9000')).toThrow(/TRUSTED_STORAGE_HOSTS/);
  });

  it('allows an exact private literal when it is allow-listed', () => {
    expect(storageEndpointHost('http://192.168.1.50:9000', ['192.168.1.50'])).toBe('192.168.1.50:9000');
  });

  it('allows a private host inside an allow-listed CIDR, rejects outside it', () => {
    expect(storageEndpointHost('http://192.168.1.77:9000', ['192.168.1.0/24'])).toBe('192.168.1.77:9000');
    expect(() => storageEndpointHost('http://192.168.2.77:9000', ['192.168.1.0/24'])).toThrow();
    expect(() => storageEndpointHost('http://10.0.0.1:9000', ['192.168.1.0/24'])).toThrow();
  });

  it('never relaxes the cloud metadata address via an unrelated CIDR', () => {
    expect(() => storageEndpointHost('http://169.254.169.254', ['10.0.0.0/8'])).toThrow();
  });
});

describe('isTrustedHost — CIDR / IPv4-mapped-IPv6 matcher', () => {
  it('matches IPv4 CIDR and bare literals', () => {
    expect(isTrustedHost('192.168.1.50', ['192.168.1.50'])).toBe(true);
    expect(isTrustedHost('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(isTrustedHost('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  it('canonicalises IPv4-mapped IPv6 so ::ffff:192.168.1.5 matches 192.168.1.0/24', () => {
    expect(isTrustedHost('::ffff:192.168.1.5', ['192.168.1.0/24'])).toBe(true);
    expect(isTrustedHost('[::ffff:192.168.1.5]', ['192.168.1.0/24'])).toBe(true);
  });

  it('matches IPv6 CIDR (fc00::/7) but not a link-local outside it', () => {
    expect(isTrustedHost('fc00::1', ['fc00::/7'])).toBe(true);
    expect(isTrustedHost('fe80::1', ['fc00::/7'])).toBe(false);
  });

  it('never matches a non-IP DNS name, and fails closed on a malformed entry', () => {
    expect(isTrustedHost('example.com', ['example.com'])).toBe(false);
    expect(isTrustedHost('192.168.1.5', ['192.168.1.0/notaprefix'])).toBe(false);
  });
});
