import { describe, it, expect } from 'vitest';
import { checkSrtUriAsGStreamerReads as check, gstUnescape } from '../lib/srt-uri-check.js';
import { srtUrl } from '../lib/url-validation.js';

const ok = (uri: string) => expect(() => check(uri)).not.toThrow();
const bad = (uri: string, msg: RegExp) => expect(() => check(uri)).toThrow(msg);

describe('checkSrtUriAsGStreamerReads (rules of Strom validate_srt_uri)', () => {
  it('accepts well-formed plain and relay addresses', () => {
    ok('srt://cdn.example.com:9000?mode=caller&passphrase=abcdefghij&pbkeylen=32');
    ok('srt://:9000?mode=listener');
    ok('srt://:9000');
    ok('srt+relay://auto?passphrase=pass%20word!1');
    ok('SRT+RELAY://abcdefghijklmnop');
    ok('srt://h.example:1?latency=200&rcvlatency=120&streamid=%23!%3A%3Ar%3Dabc');
  });

  it('refuses the scheme in another case', () => {
    bad('SRT://h.example:1', /only as 'srt:\/\/'/);
    bad('udp://h.example:1', /Not an srt/);
  });

  it('refuses a raw #', () => {
    bad('srt://h.example:1?streamid=#!::r=abc', /'#' ends the SRT address/);
  });

  it('refuses a malformed escape or %00 in a key or value', () => {
    bad('srt://h.example:1?passphrase=abc%zzdefghij', /'passphrase' has a malformed %-escape/);
    bad('srt://h.example:1?passphrase=abcdefghij%2', /malformed %-escape/);
    bad('srt://h.example:1?passphrase=abcdefghij%00', /malformed %-escape/);
    bad('srt://h.example:1?pass%zzphrase=abcdefghij', /'pass%zzphrase' has a malformed/);
  });

  it('refuses a key in the wrong case, naming the right spelling', () => {
    bad('srt://h.example:1?PassPhrase=abcdefghij', /'PassPhrase' is not read by GStreamer: use 'passphrase'/);
    bad('srt://h.example:1?Mode=caller', /'Mode' is not read by GStreamer: use 'mode'/);
    bad('srt://h.example:1?STREAMID=abc', /use 'streamid'/);
  });

  it('leaves unknown keys alone (GStreamer ignores them; not a misspelling of one it reads)', () => {
    ok('srt://h.example:1?foo=bar');
  });

  it('refuses a mode in the wrong case, and an unknown mode', () => {
    bad('srt://h.example:1?mode=Caller', /mode 'Caller' is not read by GStreamer: use 'caller'/);
    bad('srt://h.example:1?mode=LISTENER', /use 'listener'/);
    bad('srt://h.example:1?mode=push', /mode 'push' is not one of caller, listener, rendezvous/);
    bad('srt://h.example:1?mode', /mode '' is not one of/);
  });

  it('refuses a key given twice, also when one is escaped', () => {
    bad('srt://h.example:1?mode=caller&mode=listener', /'mode' is given more than once/);
    bad('srt://h.example:1?passphrase=abcdefghij&pass%70hrase=abcdefghij', /'passphrase' is given more than once/);
  });

  it('measures the passphrase in decoded UTF-8 bytes, 10–80', () => {
    ok(`srt://h.example:1?passphrase=${'a'.repeat(10)}`);
    ok(`srt://h.example:1?passphrase=${'a'.repeat(80)}`);
    ok('srt://h.example:1?passphrase=');
    bad(`srt://h.example:1?passphrase=${'a'.repeat(9)}`, /10–80 bytes \(got 9\)/);
    bad(`srt://h.example:1?passphrase=${'a'.repeat(81)}`, /got 81/);
    // 'å' is 2 bytes: 45 of them are 90 bytes, although 45 characters.
    bad(`srt://h.example:1?passphrase=${encodeURIComponent('å'.repeat(45))}`, /got 90/);
    ok(`srt://h.example:1?passphrase=${encodeURIComponent('å'.repeat(40))}`);
    // Escapes count decoded: %41 is one byte, so this is 9 bytes.
    bad('srt://h.example:1?passphrase=%41%41%41%41%41%41%41%41%41', /got 9/);
  });

  it('refuses a pbkeylen other than 0/16/24/32', () => {
    ok('srt://h.example:1?pbkeylen=0');
    ok('srt://h.example:1?pbkeylen=');
    bad('srt://h.example:1?pbkeylen=20', /pbkeylen '20' is not one of 0, 16, 24, 32/);
  });

  it('never puts the passphrase in the message', () => {
    expect(() => check('srt://h.example:1?passphrase=s3cr3t')).toThrow(/^(?!.*s3cr3t)/);
  });
});

describe('gstUnescape', () => {
  it('decodes like g_uri_unescape_string: + stays +, %00 and bad escapes are null', () => {
    expect(gstUnescape('a+b%20c')).toBe('a+b c');
    expect(gstUnescape('%C3%A5')).toBe('å');
    expect(gstUnescape('%00')).toBeNull();
    expect(gstUnescape('%g1')).toBeNull();
    expect(gstUnescape('%')).toBeNull();
  });
});

describe('srtUrl: GStreamer rules only for a new value', () => {
  it('refuses a new address that GStreamer would read differently', () => {
    expect(() => srtUrl('srt://cdn.example.com:9000?Mode=Caller', { newValue: true })).toThrow(/use 'mode'/);
    expect(() => srtUrl('srt+relay://auto?PassPhrase=abcdefghij', { newValue: true })).toThrow(/use 'passphrase'/);
  });

  it('keeps accepting such an address when it is the stored one', () => {
    expect(() => srtUrl('srt://cdn.example.com:9000?Mode=Caller')).not.toThrow();
  });

  it('measures a passphrase in decoded bytes for new and stored values alike', () => {
    // 30 'å' are 60 bytes, though 180 characters as written.
    const encoded = `srt://cdn.example.com:9000?passphrase=${encodeURIComponent('å'.repeat(30))}`;
    expect(() => srtUrl(encoded, { newValue: true })).not.toThrow();
    expect(() => srtUrl(encoded)).not.toThrow();
    // 54 characters, half of them spaces: 108 as written (%20), 54 bytes decoded.
    const spaced = `srt+relay://auto?passphrase=${encodeURIComponent('a '.repeat(27))}`;
    expect(() => srtUrl(spaced, { newValue: true })).not.toThrow();
    expect(() => srtUrl(spaced)).not.toThrow();
    // 90 bytes decoded is refused either way.
    const long = `srt://cdn.example.com:9000?passphrase=${encodeURIComponent('å'.repeat(45))}`;
    expect(() => srtUrl(long, { newValue: true })).toThrow(/got 90/);
    expect(() => srtUrl(long)).toThrow(/10–80 bytes \(got 90\)/);
  });

  it('keeps a stored passphrase that passed the older rule (length as written)', () => {
    // %41 x 4 is 12 characters as written but 4 bytes decoded.
    expect(() => srtUrl('srt://cdn.example.com:9000?passphrase=%41%41%41%41')).not.toThrow();
    expect(() => srtUrl('srt://cdn.example.com:9000?passphrase=%41%41%41%41', { newValue: true })).toThrow(/got 4/);
  });
});
