/**
 * SRT relay addresses (`srt+relay://<id>[?<query>]`).
 *
 * A relay address names a session on the SRT relay (srt-splice) that Strom
 * knows about: one public UDP port where two SRT callers using the same
 * streamid are paired end to end. The outside party (encoder, vMix, OBS…)
 * dials the relay with plain `streamid=<id>`; Strom dials it too, from inside,
 * and resolves the `srt+relay://` URI itself. Open Live never learns where the
 * relay is beyond the public `host:port` Strom reports for display.
 *
 * Open Live owns the id ("sticky": generated once, stored in the CouchDB doc,
 * never regenerated on activation, restart, flow regeneration or Strom
 * redeploy) and the passphrase (encrypted at rest like any SRT passphrase).
 *
 * `srt+relay://auto[?query]` on create/patch asks the server to generate the
 * id, the same way `srt://:0` asks for a listener port; on a patch of a doc
 * that already has a relay id, `auto` keeps that id.
 */

import { randomBytes } from 'crypto';

export const SRT_RELAY_SCHEME = 'srt+relay://';

/** The id placeholder that asks the server to generate one. */
export const SRT_RELAY_AUTO_ID = 'auto';

/** A relay id: URL-safe and short enough for an SRT streamid. */
export const SRT_RELAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Query parameters that make no sense on a relay address: Strom sets the mode
 * (it always calls the relay) and the streamid (from the id); the local bind
 * address/port of Strom's caller socket is Strom's business too.
 */
export const SRT_RELAY_FORBIDDEN_PARAMS: ReadonlySet<string> = new Set(['mode', 'streamid', 'localaddress', 'localport']);

/** True for any `srt+relay://` address (scheme is case-insensitive). */
export function isSrtRelayAddress(address: string | undefined | null): boolean {
  return typeof address === 'string' && address.trim().toLowerCase().startsWith(SRT_RELAY_SCHEME);
}

/**
 * The id and raw query of a relay address, or null when it is not one or the
 * id is malformed. The query is not validated here (a stored query holds an
 * `encv1:` passphrase), only split off.
 */
export function parseSrtRelayAddress(address: string): { id: string; query: string } | null {
  if (!isSrtRelayAddress(address)) return null;
  const rest = address.trim().slice(SRT_RELAY_SCHEME.length);
  const q = rest.indexOf('?');
  const id = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  if (!SRT_RELAY_ID_RE.test(id)) return null;
  return { id, query };
}

/** A fresh random relay id: 128 bits, base64url (22 chars, `[A-Za-z0-9_-]`). */
export function generateSrtRelayId(): string {
  return randomBytes(16).toString('base64url');
}

function buildAddress(id: string, query: string): string {
  return `${SRT_RELAY_SCHEME}${id}${query ? `?${query}` : ''}`;
}

/**
 * Replace an `auto` id with a real one. Any other address (plain SRT, or a
 * relay address with an explicit id) is returned unchanged.
 *
 * `keepFrom` is the address the document holds today (stored form, possibly
 * with an encrypted passphrase). When it is a relay address with a real id,
 * that id is kept so a re-submitted `auto` never changes the session the
 * outside party dials. Otherwise a new id is generated.
 */
export function resolveSrtRelayAddress(address: string, keepFrom?: string | null): string {
  const parsed = parseSrtRelayAddress(address);
  if (!parsed || parsed.id !== SRT_RELAY_AUTO_ID) return address;
  const kept = keepFrom ? parseSrtRelayAddress(keepFrom) : null;
  const id = kept && kept.id !== SRT_RELAY_AUTO_ID ? kept.id : generateSrtRelayId();
  return buildAddress(id, parsed.query);
}
