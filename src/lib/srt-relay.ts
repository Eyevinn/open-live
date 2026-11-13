/**
 * SRT relay addresses (`srt+relay://<id>[@<relay>][?<query>]`).
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
 * `@<relay>` names one of the relays Strom reports (`GET /api/capabilities`,
 * `protocols.srt.relays`); without it the address uses the relay called
 * `default`, as in Strom. Open Live writes the default relay without `@`.
 *
 * `srt+relay://auto[@<relay>][?query]` on create/patch asks the server to
 * generate the id, the same way `srt://:0` asks for a listener port. On a
 * patch of a doc that already has a relay id, `auto` keeps that id, and
 * `auto` without `@` also keeps the stored relay (so renewing the passphrase
 * with `srt+relay://auto?passphrase=…` never moves the stream to another
 * relay). `auto@<relay>` moves it to that relay, `auto@default` back to the
 * default one, keeping the id either way.
 *
 * The passphrase on such a patch (`auto`, with or without `@`, of a doc that
 * already holds a relay address):
 * - no `passphrase` key in the query keeps the stored passphrase (the stored,
 *   encrypted value as is) and the stored `pbkeylen` unless the query has one,
 *   so moving a stream to another relay never asks for the passphrase again.
 *   The passphrase protects the stream end to end and the relay never sees
 *   it, so there is no reason to make the operator type it again;
 * - `passphrase=` (empty) removes it;
 * - `passphrase=<value>` sets it.
 * An empty `passphrase=` is never stored or handed to Strom on any relay
 * address. Explicit ids are taken as written, apart from dropping an empty
 * `passphrase=`; plain `srt://` addresses are not touched here.
 */

import { randomBytes } from 'crypto';

export const SRT_RELAY_SCHEME = 'srt+relay://';

/** The id placeholder that asks the server to generate one. */
export const SRT_RELAY_AUTO_ID = 'auto';

/** The relay an address without `@<relay>` uses. */
export const DEFAULT_SRT_RELAY = 'default';

/** A relay name, as Strom accepts it: 1–32 characters from `a-z 0-9 -`. */
export const SRT_RELAY_NAME_RE = /^[a-z0-9-]{1,32}$/;

/** Whether `name` is a valid relay name. */
export function isValidSrtRelayName(name: string): boolean {
  return SRT_RELAY_NAME_RE.test(name);
}

/** A relay id as stored: URL-safe and short enough for an SRT streamid. */
export const SRT_RELAY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An explicit relay id a client may submit: at least 16 characters. The id is
 * the only thing standing between a public relay port and the stream when no
 * passphrase is set, so short, guessable ids are refused. Generated ids are 22.
 */
export const SRT_RELAY_EXPLICIT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

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

/** A parsed relay address. */
export interface SrtRelayAddress {
  id: string;
  /** The relay named after `@`, or null for the default relay. */
  relay: string | null;
  /** The raw query without `?`, or ''. */
  query: string;
}

/** The relay an address uses: its `@<relay>`, or `default`. */
export function srtRelayName(parsed: Pick<SrtRelayAddress, 'relay'>): string {
  return parsed.relay ?? DEFAULT_SRT_RELAY;
}

/**
 * The id, relay name and raw query of a relay address, or null when it is
 * not one, or the id or relay name is malformed. The query is not validated
 * here (a stored query holds an `encv1:` passphrase), only split off.
 */
export function parseSrtRelayAddress(address: string): SrtRelayAddress | null {
  if (!isSrtRelayAddress(address)) return null;
  const rest = address.trim().slice(SRT_RELAY_SCHEME.length);
  const q = rest.indexOf('?');
  const authority = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? '' : rest.slice(q + 1);
  const at = authority.indexOf('@');
  const id = at === -1 ? authority : authority.slice(0, at);
  const relay = at === -1 ? null : authority.slice(at + 1);
  if (!SRT_RELAY_ID_RE.test(id)) return null;
  if (relay !== null && !isValidSrtRelayName(relay)) return null;
  return { id, relay, query };
}

/** A fresh random relay id: 128 bits, base64url (22 chars, `[A-Za-z0-9_-]`). */
export function generateSrtRelayId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Write a relay address. The default relay is written without `@`, as Strom
 * writes it.
 */
export function buildSrtRelayAddress(id: string, relay: string | null, query: string): string {
  const at = relay && relay !== DEFAULT_SRT_RELAY ? `@${relay}` : '';
  return `${SRT_RELAY_SCHEME}${id}${at}${query ? `?${query}` : ''}`;
}

/** The raw `key=value` pairs of a query (not decoded). */
function queryPairs(query: string): string[] {
  return query.split('&').filter((p) => p !== '');
}

/** The key of a raw query pair, lower-cased. */
function pairKey(pair: string): string {
  const eq = pair.indexOf('=');
  return (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
}

/** True for a `passphrase=` pair with an empty value. */
function isEmptyPassphrase(pair: string): boolean {
  return pairKey(pair) === 'passphrase' && pair.indexOf('=') === pair.length - 1;
}

/** A query without any empty `passphrase=` (the way to remove a passphrase). */
export function withoutEmptyPassphrase(query: string): string {
  return queryPairs(query).filter((p) => !isEmptyPassphrase(p)).join('&');
}

/**
 * The query an `auto` patch stores, given the query the document holds today
 * (stored form). No `passphrase` key keeps the stored passphrase, and the
 * stored `pbkeylen` unless the new query has one; an empty `passphrase=`
 * removes it; any other value replaces it.
 */
export function mergeSrtRelayQuery(query: string, storedQuery: string): string {
  const pairs = queryPairs(query);
  if (pairs.some((p) => pairKey(p) === 'passphrase')) return withoutEmptyPassphrase(query);
  const stored = queryPairs(storedQuery);
  const passphrase = stored.find((p) => pairKey(p) === 'passphrase' && !isEmptyPassphrase(p));
  if (!passphrase) return pairs.join('&');
  const pbkeylen = pairs.some((p) => pairKey(p) === 'pbkeylen') ? undefined : stored.find((p) => pairKey(p) === 'pbkeylen');
  return [...pairs, passphrase, ...(pbkeylen ? [pbkeylen] : [])].join('&');
}

/**
 * Replace an `auto` id with a real one. Any other address (plain SRT, or a
 * relay address with an explicit id) is returned unchanged, except that an
 * empty `passphrase=` is dropped from a relay address.
 *
 * `keepFrom` is the address the document holds today (stored form, possibly
 * with an encrypted passphrase). When it is a relay address with a real id,
 * that id is kept so a re-submitted `auto` never changes the session the
 * outside party dials, and so is its relay unless the new address names one,
 * and its passphrase unless the new address has a `passphrase` key (see
 * `mergeSrtRelayQuery`). Otherwise a new id is generated and the address's
 * own relay and query are used.
 */
export function resolveSrtRelayAddress(address: string, keepFrom?: string | null): string {
  const parsed = parseSrtRelayAddress(address);
  if (!parsed) return address;
  if (parsed.id !== SRT_RELAY_AUTO_ID) {
    const query = withoutEmptyPassphrase(parsed.query);
    return query === parsed.query ? address : buildSrtRelayAddress(parsed.id, parsed.relay, query);
  }
  const kept = keepFrom ? parseSrtRelayAddress(keepFrom) : null;
  const keep = kept && kept.id !== SRT_RELAY_AUTO_ID ? kept : null;
  const id = keep ? keep.id : generateSrtRelayId();
  const relay = parsed.relay ?? keep?.relay ?? null;
  const query = keep ? mergeSrtRelayQuery(parsed.query, keep.query) : withoutEmptyPassphrase(parsed.query);
  return buildSrtRelayAddress(id, relay, query);
}
