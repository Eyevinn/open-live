import { describe, it, expect } from 'vitest';
import { resolveSrtConnect } from '../lib/srt-connect.js';

describe('resolveSrtConnect', () => {
  it('returns null for a non-SRT / portless string (caller then omits `connect`)', () => {
    expect(resolveSrtConnect('not-a-url', { stromUrl: 'https://strom.example.com' })).toBeNull();
    expect(resolveSrtConnect('srt://:', { stromUrl: 'https://strom.example.com' })).toBeNull();
    expect(resolveSrtConnect('srt://host', { stromUrl: 'https://strom.example.com' })).toBeNull();
  });

  it('derives the dial-in host from a public STROM_URL for a hostless listener URL', () => {
    const c = resolveSrtConnect('srt://:43524?mode=listener', { stromUrl: 'https://gpu-fra-1.osaas.io:7000' });
    expect(c).toEqual({
      uri: 'srt://gpu-fra-1.osaas.io:43524?mode=caller',
      host: 'gpu-fra-1.osaas.io',
      port: 43524,
      mode: 'caller', // external side dials in
      source: 'strom-host',
    });
  });

  it('prefers SRT_PUBLIC_HOST over the STROM_URL hostname when set', () => {
    const c = resolveSrtConnect('srt://:6000?mode=listener', {
      stromUrl: 'https://gpu-fra-1.osaas.io:7000',
      srtPublicHost: 'srt.example.com',
    });
    expect(c).toMatchObject({
      uri: 'srt://srt.example.com:6000?mode=caller',
      host: 'srt.example.com',
      port: 6000,
      mode: 'caller',
      source: 'srt-public-host',
    });
    expect(c?.reason).toBeUndefined();
  });

  it('uses SRT_PUBLIC_HOST even when STROM_URL is loopback (self-hosted behind NAT)', () => {
    const c = resolveSrtConnect('srt://:6000?mode=listener', {
      stromUrl: 'http://localhost:7000',
      srtPublicHost: 'srt.example.com',
    });
    expect(c).toMatchObject({ uri: 'srt://srt.example.com:6000?mode=caller', source: 'srt-public-host' });
  });

  it('echoes an operator-authored caller host verbatim (Strom dials out; remote is the listener)', () => {
    const c = resolveSrtConnect('srt://mixer.example.com:9000?mode=caller', { stromUrl: 'http://localhost:7000' });
    expect(c).toEqual({
      uri: 'srt://mixer.example.com:9000?mode=listener',
      host: 'mixer.example.com',
      port: 9000,
      mode: 'listener',
      source: 'authored-host',
    });
  });

  it('does NOT emit a dialable uri when STROM_URL is loopback and no override is set', () => {
    const c = resolveSrtConnect('srt://:43524?mode=listener', { stromUrl: 'http://localhost:7000' });
    expect(c).toMatchObject({
      uri: null,
      host: 'localhost',
      port: 43524,
      mode: 'caller',
      source: 'strom-host',
      reason: 'srt-host-not-loopback-reachable',
    });
  });

  it('does NOT emit a dialable uri for a private STROM_URL IP', () => {
    const c = resolveSrtConnect('srt://:43524?mode=listener', { stromUrl: 'http://10.0.0.5:7000' });
    expect(c).toMatchObject({ uri: null, host: '10.0.0.5', reason: 'srt-host-not-loopback-reachable' });
  });

  it('returns a reason when STROM_URL is unparseable', () => {
    const c = resolveSrtConnect('srt://:43524?mode=listener', { stromUrl: 'not a url' });
    expect(c).toMatchObject({ uri: null, host: null, port: 43524, source: 'unknown', reason: 'strom-url-not-parseable' });
  });

  it('treats a hostless URL with no mode as a listener (external side is a caller)', () => {
    const c = resolveSrtConnect('srt://:43524', { stromUrl: 'https://gpu.example.com:7000' });
    expect(c).toMatchObject({ uri: 'srt://gpu.example.com:43524?mode=caller', mode: 'caller', source: 'strom-host' });
  });

  it('brackets IPv6 hosts in the assembled uri', () => {
    const c = resolveSrtConnect('srt://:6000?mode=listener', { stromUrl: 'https://gpu.example.com:7000', srtPublicHost: '2001:db8::1' });
    expect(c?.uri).toBe('srt://[2001:db8::1]:6000?mode=caller');
  });
});
