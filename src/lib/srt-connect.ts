/**
 * Derive the connectable ("dial-in") SRT address an external caller must use to
 * reach an Open Live SRT output, surfaced read-only on the output API shape.
 *
 * Background (issue #176): an `mpegtssrt`/`efpsrt` output stores an
 * operator-authored *bind* URI (`OutputDoc.url`), usually the hostless listener
 * form `srt://:PORT?mode=listener`. Strom binds that port and listens; an
 * external mixer must *dial into* the Strom host to pull the feed. The bind URI
 * has a port but no host, so nothing tells the operator what host to dial. This
 * helper resolves that host from deployment config and returns the assembled
 * dial-in address, or an explicit null + reason when the host cannot be
 * determined — never a guessed/misleading address.
 *
 * Everything here is derived synchronously at read time from already-loaded data
 * plus config; nothing is persisted (the host is a property of where Strom runs,
 * not of the output — see docs/specs/srt-output-address.md §3).
 */

import { isPrivateHost } from './url-validation.js';
import { isSrtRelayAddress, parseSrtRelayAddress, srtRelayName } from './srt-relay.js';

/** Provenance of the resolved connect host. */
export type SrtConnectSource = 'authored-host' | 'srt-public-host' | 'strom-host' | 'srt-relay' | 'unknown';

/** Why `uri`/`host` could not be resolved (present only when `uri` is null). */
export type SrtConnectReason =
  | 'srt-host-not-configured'
  | 'srt-host-not-loopback-reachable'
  | 'strom-url-not-parseable'
  /** A relay address, but Strom reports no SRT relay (or is too old to have any). */
  | 'srt-relay-not-configured'
  /** A relay address naming a relay Strom does not report (see server-info `srt.relays`). */
  | 'srt-relay-unknown'
  /** A relay address, and Strom could not be asked (or has not answered yet). */
  | 'srt-relay-unreachable'
  /** Strom reports the relay, but its public address is not a usable `host:port`. */
  | 'srt-relay-public-unknown';

/**
 * A resolved address that may still not work: Strom reports the direction
 * it needs as unsupported (`srt-listener-unsupported`,
 * `srt-rendezvous-unsupported`). Reported, never enforced: present alongside
 * `uri`, or alongside `reason`.
 */
export type SrtConnectWarning = 'srt-listener-unsupported' | 'srt-rendezvous-unsupported';

export interface SrtConnect {
  /**
   * Fully-assembled dial-in address, or null when it cannot be resolved:
   * `srt://host:port?mode=…`, or for a relay address
   * `srt://<relay public host:port>?streamid=<id>`. Never carries a passphrase.
   */
  uri: string | null;
  /** Resolved SRT host external callers dial, or null when unresolved. */
  host: string | null;
  /**
   * SRT port parsed from the authored bind URI; for a relay address the
   * relay's public port, or null when that is unknown.
   */
  port: number | null;
  /** The mode the EXTERNAL side should use (inverse of the authored mode; always caller for a relay). */
  mode: 'caller' | 'listener';
  /** Provenance of `host`. */
  source: SrtConnectSource;
  /** Relay addresses only: the streamid the external side must use. */
  streamid?: string;
  /** Relay addresses only: the relay's name (`default` when the address has no `@<relay>`). */
  relay?: string;
  /** Present only when `uri` is null. */
  reason?: SrtConnectReason;
  /** Strom reports the direction this address needs as unsupported. */
  warning?: SrtConnectWarning;
}

/**
 * What Strom reports about SRT (see services/strom-capabilities.ts): the
 * relays it can use and the modes that can work.
 */
export interface SrtStromInfo {
  /**
   * `ok`: Strom answered. `unsupported`: an older Strom without capabilities
   * (no relays, every mode). `unreachable`: the values are the last known
   * ones. `unknown`: nothing is known yet. Absent reads as `ok`.
   */
  state?: 'ok' | 'unsupported' | 'unreachable' | 'unknown';
  srt: {
    modes?: { listener: boolean; caller: boolean; rendezvous: boolean };
    relays: ReadonlyArray<{ name: string; public: string }>;
  };
}

export interface SrtConnectConfig {
  /** HTTP base URL of the Strom pipeline engine (`config.stromUrl`). */
  stromUrl: string;
  /** Optional dedicated SRT-facing public host override (`config.srtPublicHost`). */
  srtPublicHost?: string | undefined;
  /** What Strom reports about SRT (relays, modes). Absent reads as unknown. */
  strom?: SrtStromInfo | undefined;
}

/**
 * Parsed authority of an SRT bind URI: host (empty for the listener form),
 * port, and the authored `mode` query param (lower-cased) if present.
 *
 * Mirrors the authority-extraction in `srtUrl()` (url-validation.ts): the
 * WHATWG URL parser rejects the hostless `srt://:PORT` form, so parse manually.
 */
function parseSrtAuthority(url: string): { host: string; port: number; mode: string | null } | null {
  const rest = url.trim().slice('srt://'.length);
  const hostPort = parseHostPort(rest.split(/[/?#]/, 1)[0] ?? '');
  if (!hostPort) return null;
  const q = url.indexOf('?');
  const mode = q === -1 ? null : new URLSearchParams(url.slice(q + 1)).get('mode');
  return { ...hostPort, mode: mode === null ? null : mode.toLowerCase() };
}

/**
 * Split `host:port` (IPv6 bracketed; host may be empty), or null when there is
 * no valid port. Used for authored SRT authorities and the relay's public
 * address alike.
 */
function parseHostPort(authority: string): { host: string; port: number } | null {
  let host = '';
  let portStr = '';
  const bracketed = authority.match(/^\[([^\]]*)\](?::(\d+))?$/); // IPv6 literal, e.g. [::1]:9000
  if (bracketed) {
    host = bracketed[1] ?? '';
    portStr = bracketed[2] ?? '';
  } else {
    const m = authority.match(/^(.*):(\d+)$/);
    if (!m) return null;
    host = m[1] ?? '';
    portStr = m[2] ?? '';
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** `host:port`, bracketing an IPv6 host. */
function formatHostPort(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

/** Hostname of an http(s) base URL, or null when it cannot be parsed. */
function hostnameOf(baseUrl: string): string | null {
  try {
    const h = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return h || null;
  } catch {
    return null;
  }
}

/** Assemble the dial-in `srt://host:port?mode=…` string, bracketing IPv6 hosts. */
function buildUri(host: string, port: number, mode: 'caller' | 'listener'): string {
  return `srt://${formatHostPort(host, port)}?mode=${mode}`;
}

/**
 * Resolve the connect (dial-in) address for an SRT output's authored bind URI.
 * Returns null when the authored URL is not a well-formed SRT URI with a port
 * (caller should then omit the `connect` object entirely).
 *
 * Resolution order (see docs/specs/srt-output-address.md §4.5):
 *   1. Authored URL has an explicit host  -> that host  (source: authored-host)
 *   2. `srtPublicHost` set                 -> that host  (source: srt-public-host)
 *   3. Hostname of `stromUrl`, unless loopback/private -> (source: strom-host)
 *   4. Otherwise host:null + a reason (never a guessed host).
 */
export function resolveSrtConnect(authoredUrl: string, cfg: SrtConnectConfig): SrtConnect | null {
  if (isSrtRelayAddress(authoredUrl)) return resolveSrtRelayConnect(authoredUrl, cfg.strom);
  const connect = resolveSrtDirectConnect(authoredUrl, cfg);
  if (!connect) return connect;
  const warning = srtModeWarning(authoredUrl, cfg.strom);
  return warning ? { ...connect, warning } : connect;
}

/**
 * The SRT mode Strom's element runs in for a plain `srt://` address, as
 * GStreamer reads it: without a host it is a listener whatever `mode` says;
 * with a host, `mode` (default caller). Null for an address that is not one.
 */
export function srtAddressMode(address: string): 'listener' | 'caller' | 'rendezvous' | null {
  if (!address.trim().startsWith('srt://')) return null;
  const parsed = parseSrtAuthority(address);
  if (!parsed) return null;
  if (!parsed.host) return 'listener';
  if (parsed.mode === 'listener' || parsed.mode === 'rendezvous') return parsed.mode;
  return 'caller';
}

/** The warning for an address whose mode Strom reports as unsupported. */
function srtModeWarning(address: string, strom: SrtStromInfo | undefined): SrtConnectWarning | undefined {
  const modes = strom?.srt.modes;
  if (!modes) return undefined;
  const mode = srtAddressMode(address);
  if (mode === 'listener' && !modes.listener) return 'srt-listener-unsupported';
  if (mode === 'rendezvous' && !modes.rendezvous) return 'srt-rendezvous-unsupported';
  return undefined;
}

function resolveSrtDirectConnect(authoredUrl: string, cfg: SrtConnectConfig): SrtConnect | null {
  const parsed = parseSrtAuthority(authoredUrl);
  if (!parsed) return null;
  const { host: authoredHost, port, mode: authoredMode } = parsed;

  // Case 1: operator authored a full caller URI with a real host (Strom dials
  // OUT to a remote listener). The remote end is the listener; the authored
  // destination is already the connectable address — nothing to resolve.
  if (authoredHost) {
    return {
      uri: buildUri(authoredHost, port, 'listener'),
      host: authoredHost,
      port,
      mode: 'listener',
      source: 'authored-host',
    };
  }

  // Hostless bind URI: Strom listens locally, the external side is the caller.
  const externalMode: 'caller' | 'listener' = authoredMode === 'caller' ? 'listener' : 'caller';

  // Case 2: explicit SRT public host override.
  if (cfg.srtPublicHost) {
    return {
      uri: buildUri(cfg.srtPublicHost, port, externalMode),
      host: cfg.srtPublicHost,
      port,
      mode: externalMode,
      source: 'srt-public-host',
    };
  }

  // Case 3/4: derive from STROM_URL hostname.
  const stromHost = hostnameOf(cfg.stromUrl);
  if (!stromHost) {
    return { uri: null, host: null, port, mode: externalMode, source: 'unknown', reason: 'strom-url-not-parseable' };
  }
  if (isPrivateHost(stromHost) || stromHost.toLowerCase() === 'localhost') {
    // Reachable only from the Strom host itself — echo it but do not present it
    // as a dialable public address.
    return {
      uri: null,
      host: stromHost,
      port,
      mode: externalMode,
      source: 'strom-host',
      reason: 'srt-host-not-loopback-reachable',
    };
  }

  return {
    uri: buildUri(stromHost, port, externalMode),
    host: stromHost,
    port,
    mode: externalMode,
    source: 'strom-host',
  };
}

/**
 * Dial-in address for a relay address (`srt+relay://<id>[@<relay>]`): the
 * outside party always calls the named relay's public `host:port` with
 * `streamid=<id>`. The passphrase is never included (the UI says "with the
 * passphrase"). Null when the relay id or name is malformed.
 */
export function resolveSrtRelayConnect(address: string, strom: SrtStromInfo | undefined): SrtConnect | null {
  const parsed = parseSrtRelayAddress(address);
  if (!parsed) return null;
  const streamid = parsed.id;
  const relayName = srtRelayName(parsed);
  const unresolved = (reason: SrtConnectReason): SrtConnect =>
    ({ uri: null, host: null, port: null, mode: 'caller', source: 'srt-relay', streamid, relay: relayName, reason });
  // Strom not answering (or not asked yet) is not the same as Strom saying
  // there is no such relay. A last-known public address is still served.
  const state = strom ? (strom.state ?? 'ok') : 'unknown';
  const definite = state === 'ok' || state === 'unsupported';
  const relays = strom?.srt.relays ?? [];
  const relay = relays.find((r) => r.name === relayName);
  if (!relay) {
    if (!definite) return unresolved('srt-relay-unreachable');
    return unresolved(relays.length === 0 ? 'srt-relay-not-configured' : 'srt-relay-unknown');
  }
  // `public` is `host:port`; tolerate an `srt://` prefix (and nothing else after the port).
  const split = parseHostPort(relay.public.trim().replace(/^srt:\/\//i, ''));
  if (!split || !split.host) return unresolved('srt-relay-public-unknown');
  return {
    uri: `srt://${formatHostPort(split.host, split.port)}?streamid=${encodeURIComponent(streamid)}`,
    host: split.host,
    port: split.port,
    mode: 'caller',
    source: 'srt-relay',
    streamid,
    relay: relayName,
  };
}
