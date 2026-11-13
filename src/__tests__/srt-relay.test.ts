/**
 * SRT relay addresses (`srt+relay://<id>[@<relay>][?query]`): parsing, id generation,
 * `auto` resolution with keep, validation, passphrase encryption at rest, and
 * the dial-in (`connect`) resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildSrtRelayAddress,
  generateSrtRelayId,
  isSrtRelayAddress,
  isValidSrtRelayName,
  parseSrtRelayAddress,
  resolveSrtRelayAddress,
  SRT_RELAY_ID_RE,
} from '../lib/srt-relay.js';
import { srtUrl } from '../lib/url-validation.js';
import { resolveSrtConnect, srtAddressMode } from '../lib/srt-connect.js';
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
      relay: null,
      query: 'passphrase=abcdefghij&latency=200',
    });
    expect(parseSrtRelayAddress('srt+relay://cam1')).toEqual({ id: 'cam1', relay: null, query: '' });
    expect(parseSrtRelayAddress('srt+relay://bad.id')).toBeNull();
    expect(parseSrtRelayAddress('srt+relay://')).toBeNull();
  });

  it('splits off a named relay after @', () => {
    expect(parseSrtRelayAddress('srt+relay://cam1@eu-north?passphrase=abcdefghij')).toEqual({
      id: 'cam1',
      relay: 'eu-north',
      query: 'passphrase=abcdefghij',
    });
    expect(parseSrtRelayAddress('srt+relay://cam1@default')).toEqual({ id: 'cam1', relay: 'default', query: '' });
    expect(parseSrtRelayAddress('srt+relay://auto@us')).toEqual({ id: 'auto', relay: 'us', query: '' });
  });

  it.each(['srt+relay://cam1@', 'srt+relay://cam1@EU', 'srt+relay://cam1@eu_north', `srt+relay://cam1@${'a'.repeat(33)}`, 'srt+relay://@eu', 'srt+relay://cam1@a@b'])(
    'refuses a malformed relay name or id: %s',
    (address) => {
      expect(parseSrtRelayAddress(address)).toBeNull();
    },
  );

  it('validates relay names as Strom does', () => {
    for (const good of ['default', 'eu-north', 'a', '0', 'a'.repeat(32)]) expect(isValidSrtRelayName(good)).toBe(true);
    for (const bad of ['', 'EU', 'eu_north', 'eu.north', 'a'.repeat(33), 'é']) expect(isValidSrtRelayName(bad)).toBe(false);
  });

  it('writes the default relay without @, others with it', () => {
    expect(buildSrtRelayAddress('cam1', null, '')).toBe('srt+relay://cam1');
    expect(buildSrtRelayAddress('cam1', 'default', 'latency=200')).toBe('srt+relay://cam1?latency=200');
    expect(buildSrtRelayAddress('cam1', 'eu-north', 'latency=200')).toBe('srt+relay://cam1@eu-north?latency=200');
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
    // No passphrase key: the stored (encrypted) passphrase stays as is.
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe('srt+relay://kept-id?passphrase=encv1:AAAA_bbb-ccc');
  });

  it('auto@<relay> picks that relay for a new id', () => {
    const out = resolveSrtRelayAddress('srt+relay://auto@eu-north?latency=200');
    expect(parseSrtRelayAddress(out)).toMatchObject({ relay: 'eu-north', query: 'latency=200' });
    expect(parseSrtRelayAddress(resolveSrtRelayAddress('srt+relay://auto@default'))!.relay).toBeNull();
  });

  it('auto without @ keeps the stored relay as well as the id (renewing the passphrase)', () => {
    const stored = 'srt+relay://kept-id@eu-north?passphrase=encv1:AAAA_bbb-ccc';
    expect(resolveSrtRelayAddress('srt+relay://auto?passphrase=newpassphrase', stored))
      .toBe('srt+relay://kept-id@eu-north?passphrase=newpassphrase');
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe('srt+relay://kept-id@eu-north?passphrase=encv1:AAAA_bbb-ccc');
  });

  it('auto@<relay> moves a stored id to that relay, and auto@default back to the default one', () => {
    const stored = 'srt+relay://kept-id@eu-north';
    expect(resolveSrtRelayAddress('srt+relay://auto@us', stored)).toBe('srt+relay://kept-id@us');
    expect(resolveSrtRelayAddress('srt+relay://auto@default', stored)).toBe('srt+relay://kept-id');
    expect(resolveSrtRelayAddress('srt+relay://auto@us', 'srt+relay://kept-id')).toBe('srt+relay://kept-id@us');
  });

  it('a relay switch without a passphrase key keeps the stored passphrase and pbkeylen', () => {
    const stored = 'srt+relay://kept-id@eu-north?passphrase=encv1:AAAA_bbb-ccc&pbkeylen=32&latency=120';
    expect(resolveSrtRelayAddress('srt+relay://auto@us?latency=200', stored))
      .toBe('srt+relay://kept-id@us?latency=200&passphrase=encv1:AAAA_bbb-ccc&pbkeylen=32');
    expect(resolveSrtRelayAddress('srt+relay://auto@default', stored))
      .toBe('srt+relay://kept-id?passphrase=encv1:AAAA_bbb-ccc&pbkeylen=32');
    // A pbkeylen in the new query wins over the stored one.
    expect(resolveSrtRelayAddress('srt+relay://auto@us?pbkeylen=16', stored))
      .toBe('srt+relay://kept-id@us?pbkeylen=16&passphrase=encv1:AAAA_bbb-ccc');
  });

  it('an empty passphrase= removes the passphrase, with or without a relay switch, and is not stored', () => {
    const stored = 'srt+relay://kept-id@eu-north?passphrase=encv1:AAAA_bbb-ccc&pbkeylen=32';
    expect(resolveSrtRelayAddress('srt+relay://auto?passphrase=', stored)).toBe('srt+relay://kept-id@eu-north');
    expect(resolveSrtRelayAddress('srt+relay://auto@us?latency=200&passphrase=', stored))
      .toBe('srt+relay://kept-id@us?latency=200');
    // On create (nothing stored) and on an explicit id it is dropped too.
    const created = parseSrtRelayAddress(resolveSrtRelayAddress('srt+relay://auto?passphrase=&latency=200'))!;
    expect(created.query).toBe('latency=200');
    expect(resolveSrtRelayAddress('srt+relay://explicit-id-0123456789@us?passphrase=', stored))
      .toBe('srt+relay://explicit-id-0123456789@us');
  });

  it('passphrase=<value> on a relay switch replaces the stored passphrase (and the stored pbkeylen goes)', () => {
    const stored = 'srt+relay://kept-id?passphrase=encv1:AAAA_bbb-ccc&pbkeylen=32';
    expect(resolveSrtRelayAddress('srt+relay://auto@us?passphrase=newpassphrase', stored))
      .toBe('srt+relay://kept-id@us?passphrase=newpassphrase');
  });

  it('same relay, no passphrase key: the stored address comes back unchanged', () => {
    const stored = 'srt+relay://kept-id@eu-north?passphrase=encv1:AAAA_bbb-ccc&pbkeylen=24';
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe(stored);
    expect(resolveSrtRelayAddress('srt+relay://auto@eu-north', stored)).toBe(stored);
  });

  it('generates a new id when the stored address is not a relay address', () => {
    const out = resolveSrtRelayAddress('srt+relay://auto', 'srt://:47100?mode=listener');
    expect(parseSrtRelayAddress(out)!.id).not.toBe('auto');
  });

  it('leaves an explicit id and plain SRT addresses alone', () => {
    expect(resolveSrtRelayAddress('srt+relay://mine', 'srt+relay://other')).toBe('srt+relay://mine');
    expect(resolveSrtRelayAddress('srt+relay://mine-0123456789abcdef', 'srt+relay://other?passphrase=encv1:AAAA'))
      .toBe('srt+relay://mine-0123456789abcdef');
    expect(resolveSrtRelayAddress('srt://:0?mode=listener&passphrase=', 'srt+relay://other')).toBe('srt://:0?mode=listener&passphrase=');
    expect(resolveSrtRelayAddress('srt://:0?mode=listener', 'srt+relay://other')).toBe('srt://:0?mode=listener');
  });
});

describe('srtUrl() — relay addresses', () => {
  it.each([
    'srt+relay://auto',
    'srt+relay://auto?passphrase=abcdefghij',
    'srt+relay://cam1-studio-a-0001',
    'srt+relay://Cam_1-2_aaaaaaaaaa?latency=200&pbkeylen=32',
    'srt+relay://auto@eu-north',
    'srt+relay://auto@default?passphrase=abcdefghij',
    'srt+relay://cam1-studio-a-0001@us-east-1',
    `srt+relay://auto@${'a'.repeat(32)}`,
    `srt+relay://${'a'.repeat(16)}`,
    `srt+relay://${'a'.repeat(64)}`,
  ])('accepts %s', (url) => {
    expect(() => srtUrl(url)).not.toThrow();
  });

  it.each([
    ['empty id', 'srt+relay://'],
    ['id too long', `srt+relay://${'a'.repeat(65)}`],
    ['dot in id', 'srt+relay://cam.1-studio-a-0001'],
    ['host:port instead of id', 'srt+relay://relay.example.com:9000'],
    ['unsafe query char', 'srt+relay://cam1?x="y"'],
    ['path', 'srt+relay://cam1/x'],
  ])('rejects %s', (_label, url) => {
    expect(() => srtUrl(url)).toThrow();
  });

  it.each(['srt+relay://auto@', 'srt+relay://auto@EU', 'srt+relay://auto@eu_north', `srt+relay://auto@${'a'.repeat(33)}`, 'srt+relay://auto@a@b'])(
    'rejects the relay name in %s',
    (url) => {
      expect(() => srtUrl(url)).toThrow(/Invalid SRT relay name/);
    },
  );

  it('checks the id before @ like any other id', () => {
    expect(() => srtUrl('srt+relay://cam1@eu-north')).toThrow(/16–64 characters/);
  });

  it('refuses a query key without a value on a new address (it crashes GStreamer)', () => {
    expect(() => srtUrl('srt+relay://auto?latency', { newValue: true })).toThrow(/'latency' has no value/);
  });

  it('accepts an empty passphrase= on a new address (it removes the passphrase)', () => {
    expect(() => srtUrl('srt+relay://auto?passphrase=', { newValue: true })).not.toThrow();
    expect(() => srtUrl('srt+relay://auto@eu-north?latency=200&passphrase=', { newValue: true })).not.toThrow();
    expect(() => srtUrl('srt+relay://auto?passphrase', { newValue: true })).toThrow(/'passphrase' has no value/);
  });

  it.each(['mode=caller', 'streamid=other', 'MODE=listener', 'localport=5000', 'localaddress=1.2.3.4', '%73treamid=x'])(
    'rejects the plain-SRT-only param %s',
    (q) => {
      expect(() => srtUrl(`srt+relay://cam1-studio-a-0001?${q}`)).toThrow(/not allowed on an SRT relay address/);
    },
  );

  it.each(['cam1', 'a', `${'a'.repeat(15)}`])('rejects the explicit id %s as too short (guessable)', (id) => {
    expect(() => srtUrl(`srt+relay://${id}`)).toThrow(/16–64 characters.*guesses the id/);
  });

  it('applies the 10–80 passphrase rule', () => {
    expect(() => srtUrl('srt+relay://auto?passphrase=short')).toThrow(/10–80/);
    expect(() => srtUrl(`srt+relay://auto?passphrase=${'p'.repeat(81)}`)).toThrow(/10–80/);
    expect(() => srtUrl(`srt+relay://auto?passphrase=${'p'.repeat(80)}`)).not.toThrow();
    expect(() => srtUrl('srt+relay://auto?passphrase=')).not.toThrow();
  });

  it('matches the scheme case-insensitively, like the parser and Strom', () => {
    for (const url of ['SRT+RELAY://auto', 'Srt+Relay://cam1-studio-a-0001?latency=200']) {
      expect(isSrtRelayAddress(url)).toBe(true);
      expect(() => srtUrl(url)).not.toThrow();
    }
    // Validated as a relay address, not as a malformed srt:// URL.
    expect(() => srtUrl('SRT+RELAY://cam1')).toThrow(/16–64 characters/);
    expect(() => srtUrl('SRT+RELAY://auto?mode=caller')).toThrow(/not allowed on an SRT relay address/);
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
    // ... and keeps the stored passphrase, still encrypted.
    expect(resolveSrtRelayAddress('srt+relay://auto', stored)).toBe(stored.replace('&latency=200', ''));
  });
});

const RELAYS = [
  { name: 'default', public: 'relay.example.com:9000' },
  { name: 'eu-north', public: 'srt-eu.example.com:9100' },
];
const strom = (relays: Array<{ name: string; public: string }>, state?: 'ok' | 'unsupported' | 'unreachable' | 'unknown') => ({
  ...(state ? { state } : {}),
  srt: { relays },
});

describe('resolveSrtConnect() — relay addresses', () => {
  it('builds the dial-in address from the default relay public host:port, without the passphrase', () => {
    const c = resolveSrtConnect('srt+relay://cam1?passphrase=supersecretpass&latency=200', { ...CFG, strom: strom(RELAYS) });
    expect(c).toEqual({
      uri: 'srt://relay.example.com:9000?streamid=cam1',
      host: 'relay.example.com',
      port: 9000,
      mode: 'caller',
      source: 'srt-relay',
      streamid: 'cam1',
      relay: 'default',
    });
    expect(JSON.stringify(c)).not.toContain('supersecretpass');
  });

  it('uses the named relay public address for @<relay>', () => {
    const c = resolveSrtConnect('srt+relay://cam1@eu-north?passphrase=supersecretpass', { ...CFG, strom: strom(RELAYS) });
    expect(c).toMatchObject({
      uri: 'srt://srt-eu.example.com:9100?streamid=cam1',
      host: 'srt-eu.example.com',
      port: 9100,
      relay: 'eu-north',
    });
    expect(resolveSrtConnect('srt+relay://cam1@default', { ...CFG, strom: strom(RELAYS) })?.uri).toBe('srt://relay.example.com:9000?streamid=cam1');
  });

  it('srt-relay-unknown for a relay name Strom does not report', () => {
    expect(resolveSrtConnect('srt+relay://cam1@us', { ...CFG, strom: strom(RELAYS) })).toEqual({
      uri: null,
      host: null,
      port: null,
      mode: 'caller',
      source: 'srt-relay',
      streamid: 'cam1',
      relay: 'us',
      reason: 'srt-relay-unknown',
    });
    // Only named relays configured: an address without @ wants `default`.
    expect(resolveSrtConnect('srt+relay://cam1', { ...CFG, strom: strom([RELAYS[1]!]) })?.reason).toBe('srt-relay-unknown');
  });

  it('brackets an IPv6 public host', () => {
    const c = resolveSrtConnect('srt+relay://cam1', { ...CFG, strom: strom([{ name: 'default', public: '[2001:db8::1]:9000' }]) });
    expect(c?.uri).toBe('srt://[2001:db8::1]:9000?streamid=cam1');
    expect(c?.host).toBe('2001:db8::1');
  });

  it('tolerates an srt:// prefix on the public address', () => {
    const c = resolveSrtConnect('srt+relay://cam1', { ...CFG, strom: strom([{ name: 'default', public: 'srt://relay.example.com:9000' }]) });
    expect(c?.uri).toBe('srt://relay.example.com:9000?streamid=cam1');
  });

  it('ignores SRT_PUBLIC_HOST and the Strom host for relay addresses', () => {
    const c = resolveSrtConnect('srt+relay://cam1', { ...CFG, srtPublicHost: 'srt.example.com', strom: strom(RELAYS) });
    expect(c?.host).toBe('relay.example.com');
  });

  it('null uri with srt-relay-not-configured when Strom positively reports no relay, or is too old to have any', () => {
    for (const state of ['ok', 'unsupported'] as const) {
      expect(resolveSrtConnect('srt+relay://cam1@eu-north', { ...CFG, strom: strom([], state) })).toMatchObject({
        uri: null,
        source: 'srt-relay',
        relay: 'eu-north',
        reason: 'srt-relay-not-configured',
      });
    }
  });

  it('null uri with srt-relay-unreachable when Strom could not be asked (or was not)', () => {
    for (const info of [undefined, strom([], 'unreachable'), strom([], 'unknown'), strom([RELAYS[1]!], 'unreachable')]) {
      expect(resolveSrtConnect('srt+relay://cam1', { ...CFG, strom: info })).toMatchObject({
        uri: null,
        source: 'srt-relay',
        streamid: 'cam1',
        reason: 'srt-relay-unreachable',
      });
    }
  });

  it('serves the last known public address while Strom is unreachable', () => {
    const c = resolveSrtConnect('srt+relay://cam1@eu-north', { ...CFG, strom: strom(RELAYS, 'unreachable') });
    expect(c?.uri).toBe('srt://srt-eu.example.com:9100?streamid=cam1');
  });

  it('a malformed public address reads as unknown', () => {
    for (const pub of ['relay.example.com', ':9000', 'relay.example.com:99999']) {
      expect(resolveSrtConnect('srt+relay://cam1', { ...CFG, strom: strom([{ name: 'default', public: pub }]) })?.reason).toBe('srt-relay-public-unknown');
    }
  });

  it('plain SRT addresses resolve as before', () => {
    expect(resolveSrtConnect('srt://:47100?mode=listener', CFG)).toMatchObject({
      uri: 'srt://strom.example.com:47100?mode=caller',
      source: 'strom-host',
    });
  });
});

describe('resolveSrtConnect() — SRT modes Strom reports (reported, not enforced)', () => {
  const modes = (listener: boolean, rendezvous = listener) => ({ state: 'ok' as const, srt: { modes: { listener, caller: true, rendezvous }, relays: [] } });

  it('warns on a listener address when Strom reports listener unsupported, and still resolves it', () => {
    for (const address of ['srt://:47100?mode=listener', 'srt://:47100', 'srt://0.0.0.0:47100?mode=listener', 'srt://:47100?mode=caller']) {
      const c = resolveSrtConnect(address, { ...CFG, strom: modes(false) });
      expect(c?.warning).toBe('srt-listener-unsupported');
      expect(c?.port).toBe(47100);
    }
    expect(resolveSrtConnect('srt://:47100?mode=listener', { ...CFG, strom: modes(false) })?.uri).toBe('srt://strom.example.com:47100?mode=caller');
  });

  it('warns on a rendezvous address when Strom reports rendezvous unsupported', () => {
    expect(resolveSrtConnect('srt://peer.example.com:9000?mode=rendezvous', { ...CFG, strom: modes(false) })?.warning).toBe('srt-rendezvous-unsupported');
    expect(resolveSrtConnect('srt://peer.example.com:9000?mode=rendezvous', { ...CFG, strom: modes(true) })?.warning).toBeUndefined();
  });

  it('never warns on a caller address, nor when the modes are supported or not known', () => {
    expect(resolveSrtConnect('srt://cdn.example.com:9000', { ...CFG, strom: modes(false) })?.warning).toBeUndefined();
    expect(resolveSrtConnect('srt://cdn.example.com:9000?mode=caller', { ...CFG, strom: modes(false) })?.warning).toBeUndefined();
    expect(resolveSrtConnect('srt://:47100?mode=listener', { ...CFG, strom: modes(true) })?.warning).toBeUndefined();
    expect(resolveSrtConnect('srt://:47100?mode=listener', CFG)?.warning).toBeUndefined();
  });
});

describe('srtAddressMode()', () => {
  it.each([
    ['srt://:47100', 'listener'],
    ['srt://:47100?mode=caller', 'listener'],
    ['srt://host.example:1?mode=listener', 'listener'],
    ['srt://host.example:1', 'caller'],
    ['srt://host.example:1?mode=caller', 'caller'],
    ['srt://host.example:1?mode=rendezvous', 'rendezvous'],
    ['srt+relay://cam1', null],
    ['srt://nonsense', null],
  ])('%s -> %s', (address, mode) => {
    expect(srtAddressMode(address)).toBe(mode);
  });
});
