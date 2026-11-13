/**
 * Check an SRT address the way GStreamer's SRT elements (in Strom) read it,
 * so an address that would run differently from how it is written is refused
 * when it is saved, not first when the production is activated.
 *
 * GStreamer drops most problems without a word: keys are matched exactly
 * (`PassPhrase=` is ignored, so a URI that looks encrypted runs unencrypted),
 * a `mode` in another case (`mode=Caller`) is read by GLib 2.88 and later but
 * ignored by older GLib, a value with a malformed escape or `%00` is not set,
 * and a raw `#` cuts the rest of the URI off. A key without `=` (`?latency`)
 * crashes GStreamer 1.28.6 when the element starts. Strom refuses such a
 * URI when it builds the flow (`validate_srt_uri` in Strom's
 * `types/src/srt_uri.rs`, the source of truth for these rules); this is the
 * same check at Open Live's API edge.
 *
 * Only for values being written: stored records are never re-checked, so an
 * older document keeps working (renames, activation) as before.
 */

const SRT_SCHEME = 'srt://';
const SRT_RELAY_SCHEME = 'srt+relay://';

/** Shortest and longest passphrase libsrt accepts, in bytes. */
export const SRT_PASSPHRASE_MIN_BYTES = 10;
export const SRT_PASSPHRASE_MAX_BYTES = 80;

const GST_SRT_MODES = ['caller', 'listener', 'rendezvous'] as const;
const SRT_PBKEYLEN_ACCEPTED = ['0', '16', '24', '32'];

/**
 * The query keys GStreamer's SRT elements read: the ones
 * `gst_srt_object_set_uri` handles itself and its `srt_options` table
 * (identical in GStreamer 1.22 and 1.28). Used to name the right spelling of
 * a key that differs from one of them only in case.
 */
const GST_SRT_URI_KEYS = [
  'mode', 'localaddress', 'localport', 'poll-timeout', 'mss', 'fc', 'sndbuf', 'rcvbuf', 'maxbw',
  'tsbpdmode', 'latency', 'inputbw', 'oheadbw', 'passphrase', 'pbkeylen', 'ipttl', 'iptos',
  'tlpktdrop', 'snddropdelay', 'nakreport', 'conntimeo', 'drifttracer', 'lossmaxttl', 'rcvlatency',
  'peerlatency', 'minversion', 'streamid', 'congestion', 'messageapi', 'payloadsize', 'transtype',
  'kmrefreshrate', 'kmpreannounce', 'enforcedencryption', 'ipv6only', 'peeridletimeo',
  'bindtodevice', 'packetfilter', 'retransmitalgo',
];

const HEX = /^[0-9A-Fa-f]{2}$/;
const utf8 = new TextDecoder('utf-8'); // non-fatal: invalid bytes become U+FFFD, as in Strom

/**
 * Decode `%XX` escapes as `g_uri_unescape_string` does: null for a `%` not
 * followed by two hex digits, and for `%00`. GStreamer then sets no value at
 * all. `+` stays a `+` (unlike URLSearchParams, which reads it as a space).
 */
export function gstUnescape(s: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%') {
      const hex = s.slice(i + 1, i + 3);
      if (!HEX.test(hex)) return null;
      const byte = parseInt(hex, 16);
      if (byte === 0) return null;
      bytes.push(byte);
      i += 2;
    } else {
      bytes.push(...Buffer.from(s[i]!, 'utf8'));
    }
  }
  return utf8.decode(Uint8Array.from(bytes));
}

/**
 * Throws an Error with an operator-facing message if GStreamer would not read
 * the address as written, or libsrt would refuse it. The message never holds
 * a parameter value that may be secret (only keys, `mode` and `pbkeylen`).
 */
export function checkSrtUriAsGStreamerReads(address: string): void {
  const uri = address.trim();
  let rest: string;
  if (uri.slice(0, SRT_RELAY_SCHEME.length).toLowerCase() === SRT_RELAY_SCHEME) {
    rest = uri.slice(SRT_RELAY_SCHEME.length);
  } else if (uri.startsWith(SRT_SCHEME)) {
    rest = uri.slice(SRT_SCHEME.length);
  } else if (uri.slice(0, SRT_SCHEME.length).toLowerCase() === SRT_SCHEME) {
    throw new Error(`GStreamer accepts the SRT scheme only as '${SRT_SCHEME}', in lower case`);
  } else {
    throw new Error(`Not an ${SRT_SCHEME} or ${SRT_RELAY_SCHEME} address`);
  }
  if (rest.includes('#')) {
    throw new Error("'#' ends the SRT address for GStreamer, which drops everything after it: write it as %23");
  }
  const q = rest.indexOf('?');
  const query = q === -1 ? '' : rest.slice(q + 1);

  const seen = new Set<string>();
  for (const param of query.split('&')) {
    if (!param) continue;
    const eq = param.indexOf('=');
    const rawKey = eq === -1 ? param : param.slice(0, eq);
    const rawValue = eq === -1 ? null : param.slice(eq + 1);
    const badEscape = (key: string) =>
      new Error(`SRT parameter '${key}' has a malformed %-escape or %00, so GStreamer does not set it: write '%' as %25`);
    const key = gstUnescape(rawKey);
    if (key === null) throw badEscape(rawKey);
    if (rawValue === null) {
      throw new Error(`SRT parameter '${key}' has no value, which crashes GStreamer: write '${key}=<value>' or remove it`);
    }
    const value = gstUnescape(rawValue);
    if (value === null) throw badEscape(key);

    if (!GST_SRT_URI_KEYS.includes(key)) {
      const expected = GST_SRT_URI_KEYS.find((k) => k.toLowerCase() === key.toLowerCase());
      if (expected) throw new Error(`SRT parameter '${key}' is not read by GStreamer: use '${expected}'`);
    }
    if (seen.has(key)) throw new Error(`SRT parameter '${key}' is given more than once`);

    if (key === 'mode' && !(GST_SRT_MODES as readonly string[]).includes(value)) {
      const expected = GST_SRT_MODES.find((m) => m.toLowerCase() === value.toLowerCase());
      throw new Error(
        expected
          ? `SRT mode '${value}' behaves differently across GLib versions (older ones ignore it): use '${expected}'`
          : `SRT mode '${value}' is not one of ${GST_SRT_MODES.join(', ')}`,
      );
    }
    if (key === 'passphrase') {
      const len = Buffer.byteLength(value, 'utf8');
      if (len !== 0 && (len < SRT_PASSPHRASE_MIN_BYTES || len > SRT_PASSPHRASE_MAX_BYTES)) {
        throw new Error(
          `SRT passphrase must be ${SRT_PASSPHRASE_MIN_BYTES}–${SRT_PASSPHRASE_MAX_BYTES} bytes ` +
            `(got ${len}), or empty for no encryption`,
        );
      }
    }
    if (key === 'pbkeylen' && value !== '' && !SRT_PBKEYLEN_ACCEPTED.includes(value)) {
      throw new Error(`SRT pbkeylen '${value}' is not one of ${SRT_PBKEYLEN_ACCEPTED.join(', ')}`);
    }
    seen.add(key);
  }
}
