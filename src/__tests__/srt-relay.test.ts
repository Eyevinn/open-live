/**
 * SRT relay addresses (`srt+relay://<id>[?query]`): parsing, id generation,
 * `auto` resolution with keep, validation, passphrase encryption at rest, and
 * the dial-in (`connect`) resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateSrtRelayId,
  isSrtRelayAddress,
  parseSrtRelayAddress,
  resolveSrtRelayAddress,
  SRT_RELAY_ID_RE,
} from '../lib/srt-relay.js';
import { srtUrl } from '../lib/url-validation.js';
import { resolveSrtConnect } from '../lib/srt-connect.js';
import { listenerPortRequest } from '../services/listener-ports.js';
import {
  decryptAddressPassphrase,
  encryptAddressPassphrase,
  resetKeyCache,
} from '../lib/srt-passphrase-crypto.js';

const CFG = { stromUrl: 'https://strom.example.com' };

describe('relay address parsing', () => {
  it('recognises the scheme', () => {
    expect(isSrtRelayAddress('srt+relay://cam1')).toBe(true);
    expect(isSrtRelayAddress('srt://:9000')).toBe(false);
    expect(isSrtRelayAddress(undefined)).toBe(false);
  });

  it('splits id and query', () => {
    expect(parseSrtRelayAddress('srt+relay://cam_1-x?passphrase=abcdefghij&latency=200')).toEqual({
      id: 'cam_1-x',
      query: 'passphrase=abcdefghij&latency=200',
    });
    expect(parseSrtRelayAddress('srt+relay://cam1')).toEqual({ id: 'cam1', query: '' });
    expect(parseSrtRelayAddress('srt+relay://bad.id')).toBeNull();
    expect(parseSrtRelayAddress('srt+relay://')).toBeNull();
  });

  it('a relay address binds no listener port', () => {
    expect(listenerPortRequest('srt+relay://cam1')).toBeNull();
    expect(listenerPortRequest('srt+relay://auto?passphrase=abcdefghij')).toBeNull();
  });
});

describe('relay id generation and auto/keep', () => {
  it('generates a URL-safe 128-bit id, different every time', () => {
    const a = generateSrtRelayId();
    const b = generateSrtRelayId();
    expect(a).toMatch(SRT_RELAY_ID_RE);
    expect(a).toHaveLength(22);
    expect(a).not.toBe(b);
  });

  it('replaces auto with a generated id and keeps the query', () => {
    const out = resolveSrtRelayAddress('srt+relay://auto?passphrase=abcdefghij&latency=200');
    const parsed = parseSrtRelayAddress(out)!;
    expect(parsed.id).not.toBe('auto');
    expect(parsed.id).toMatch(SRT_RELAY_ID_RE);
    expect(parsed.query).toBe('passphrase=abcdefghij&latency=200');
  });

  it('keeps the stored relay id on auto, even when the stored passphrase is encrypted', () => {
    const stored = 'srt+relay://kept-id?passphrase=encv1:AAAA_bbb-ccc&latency=120';
    expect(resolveSrtRelayAddress('srt+relay://auto?passphrase=newpassphrase', stored))
      .toBe('srt+relay://kept-id?passphrase=newpassphrase');
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe('srt+relay://kept-id');
  });

  it('generates a new id when the stored address is not a relay address', () => {
    const out = resolveSrtRelayAddress('srt+relay://auto', 'srt://:47100?mode=listener');
    expect(parseSrtRelayAddress(out)!.id).not.toBe('auto');
  });

  it('leaves an explicit id and plain SRT addresses alone', () => {
    expect(resolveSrtRelayAddress('srt+relay://mine', 'srt+relay://other')).toBe('srt+relay://mine');
    expect(resolveSrtRelayAddress('srt://:0?mode=listener', 'srt+relay://other')).toBe('srt://:0?mode=listener');
  });
});

describe('srtUrl() — relay addresses', () => {
  it.each([
    'srt+relay://auto',
    'srt+relay://auto?passphrase=abcdefghij',
    'srt+relay://cam1',
    'srt+relay://Cam_1-2?latency=200&pbkeylen=32',
    `srt+relay://${'a'.repeat(64)}`,
  ])('accepts %s', (url) => {
    expect(() => srtUrl(url)).not.toThrow();
  });

  it.each([
    ['empty id', 'srt+relay://'],
    ['id too long', `srt+relay://${'a'.repeat(65)}`],
    ['dot in id', 'srt+relay://cam.1'],
    ['host:port instead of id', 'srt+relay://relay.example.com:9000'],
    ['unsafe query char', 'srt+relay://cam1?x="y"'],
    ['path', 'srt+relay://cam1/x'],
  ])('rejects %s', (_label, url) => {
    expect(() => srtUrl(url)).toThrow();
  });

  it.each(['mode=caller', 'streamid=other', 'MODE=listener', 'localport=5000', 'localaddress=1.2.3.4', '%73treamid=x'])(
    'rejects the plain-SRT-only param %s',
    (q) => {
      expect(() => srtUrl(`srt+relay://cam1?${q}`)).toThrow(/not allowed on an SRT relay address/);
    },
  );

  it('applies the 10–79 passphrase rule', () => {
    expect(() => srtUrl('srt+relay://auto?passphrase=short')).toThrow(/10–79/);
    expect(() => srtUrl(`srt+relay://auto?passphrase=${'p'.repeat(80)}`)).toThrow(/10–79/);
    expect(() => srtUrl(`srt+relay://auto?passphrase=${'p'.repeat(79)}`)).not.toThrow();
    expect(() => srtUrl('srt+relay://auto?passphrase=')).not.toThrow();
  });

  it('control characters are rejected before anything else', () => {
    expect(() => srtUrl('srt+relay://cam1\n')).toThrow(/Control characters/);
  });
});

describe('relay addresses — passphrase encryption at rest', () => {
  const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
  const originalEnv = { ...process.env };
  beforeEach(() => {
    resetKeyCache();
    process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
    delete process.env['NODE_ENV'];
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    resetKeyCache();
  });

  it('encrypts only the passphrase, keeps the id readable, and round-trips', () => {
    const plain = 'srt+relay://sticky-id?passphrase=supersecretpass&latency=200';
    const stored = encryptAddressPassphrase(plain);
    expect(stored).toMatch(/^srt\+relay:\/\/sticky-id\?passphrase=encv1:[A-Za-z0-9_-]+&latency=200$/);
    expect(stored).not.toContain('supersecretpass');
    expect(parseSrtRelayAddress(stored)!.id).toBe('sticky-id');
    expect(decryptAddressPassphrase(stored)).toBe(plain);
    // `auto` on a later patch keeps the id read from the encrypted stored form.
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe('srt+relay://sticky-id');
  });
});

describe('resolveSrtConnect() — relay addresses', () => {
  it('builds the dial-in address from the relay public host:port, without the passphrase', () => {
    const c = resolveSrtConnect('srt+relay://cam1?passphrase=supersecretpass&latency=200', {
      ...CFG,
      srtRelay: { configured: true, public: 'relay.example.com:9000' },
    });
    expect(c).toEqual({
      uri: 'srt://relay.example.com:9000?streamid=cam1',
      host: 'relay.example.com',
      port: 9000,
      mode: 'caller',
      source: 'srt-relay',
      streamid: 'cam1',
    });
    expect(JSON.stringify(c)).not.toContain('supersecretpass');
  });

  it('brackets an IPv6 public host', () => {
    const c = resolveSrtConnect('srt+relay://cam1', { ...CFG, srtRelay: { configured: true, public: '[2001:db8::1]:9000' } });
    expect(c?.uri).toBe('srt://[2001:db8::1]:9000?streamid=cam1');
    expect(c?.host).toBe('2001:db8::1');
  });

  it('ignores SRT_PUBLIC_HOST and the Strom host for relay addresses', () => {
    const c = resolveSrtConnect('srt+relay://cam1', {
      ...CFG,
      srtPublicHost: 'srt.example.com',
      srtRelay: { configured: true, public: 'relay.example.com:9000' },
    });
    expect(c?.host).toBe('relay.example.com');
  });

  it('null uri with a reason when the relay public address is unknown', () => {
    expect(resolveSrtConnect('srt+relay://cam1', { ...CFG, srtRelay: { configured: true, public: null } })).toEqual({
      uri: null,
      host: null,
      port: null,
      mode: 'caller',
      source: 'srt-relay',
      streamid: 'cam1',
      reason: 'srt-relay-public-unknown',
    });
  });

  it('null uri with a reason when Strom has no relay (or was not asked)', () => {
    for (const srtRelay of [undefined, { configured: false, public: null }]) {
      expect(resolveSrtConnect('srt+relay://cam1', { ...CFG, srtRelay })).toMatchObject({
        uri: null,
        source: 'srt-relay',
        reason: 'srt-relay-not-configured',
      });
    }
  });

  it('plain SRT addresses resolve as before', () => {
    expect(resolveSrtConnect('srt://:47100?mode=listener', CFG)).toMatchObject({
      uri: 'srt://strom.example.com:47100?mode=caller',
      source: 'strom-host',
    });
  });
});
