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
import { isSrtRelayAddress, parseSrtRelayAddress } from './srt-relay.js';

/** Provenance of the resolved connect host. */
export type SrtConnectSource = 'authored-host' | 'srt-public-host' | 'strom-host' | 'srt-relay' | 'unknown';

/** Why `uri`/`host` could not be resolved (present only when `uri` is null). */
export type SrtConnectReason =
  | 'srt-host-not-configured'
  | 'srt-host-not-loopback-reachable'
  | 'strom-url-not-parseable'
  /** A relay address, but Strom reports no SRT relay (or cannot be asked). */
  | 'srt-relay-not-configured'
  /** Strom has a relay but does not report its public address. */
  | 'srt-relay-public-unknown';

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
  /** Present only when `uri` is null. */
  reason?: SrtConnectReason;
}

/** What Strom reports about its SRT relay (see services/srt-relay-status.ts). */
export interface SrtRelayInfo {
  configured: boolean;
  /** The relay's public `host:port`, or null when unknown. */
  public: string | null;
}

export interface SrtConnectConfig {
  /** HTTP base URL of the Strom pipeline engine (`config.stromUrl`). */
  stromUrl: string;
  /** Optional dedicated SRT-facing public host override (`config.srtPublicHost`). */
  srtPublicHost?: string | undefined;
  /** Strom's SRT relay, for relay addresses. Absent reads as not configured. */
  srtRelay?: SrtRelayInfo | undefined;
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
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';

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

  const q = url.indexOf('?');
  const mode = q === -1 ? null : new URLSearchParams(url.slice(q + 1)).get('mode');
  return { host, port, mode: mode === null ? null : mode.toLowerCase() };
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
  const authority = host.includes(':') ? `[${host}]` : host;
  return `srt://${authority}:${port}?mode=${mode}`;
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
  if (isSrtRelayAddress(authoredUrl)) return resolveSrtRelayConnect(authoredUrl, cfg.srtRelay);
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

/** Split a relay's public `host:port` (IPv6 bracketed), or null when it is not one. */
function splitHostPort(hostPort: string): { host: string; port: number } | null {
  const m = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:\[\]/?#]+)):(\d{1,5})$/.exec(hostPort.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (m[1] ?? m[2])!, port };
}

/**
 * Dial-in address for a relay address (`srt+relay://<id>`): the outside party
 * always calls the relay's public `host:port` with `streamid=<id>`. The
 * passphrase is never included (the UI says "with the passphrase"). Null when
 * the relay id is malformed.
 */
export function resolveSrtRelayConnect(address: string, relay: SrtRelayInfo | undefined): SrtConnect | null {
  const parsed = parseSrtRelayAddress(address);
  if (!parsed) return null;
  const streamid = parsed.id;
  if (!relay?.configured) {
    return { uri: null, host: null, port: null, mode: 'caller', source: 'srt-relay', streamid, reason: 'srt-relay-not-configured' };
  }
  const split = relay.public ? splitHostPort(relay.public) : null;
  if (!relay.public || !split) {
    return { uri: null, host: null, port: null, mode: 'caller', source: 'srt-relay', streamid, reason: 'srt-relay-public-unknown' };
  }
  const authority = split.host.includes(':') ? `[${split.host}]` : split.host;
  return {
    uri: `srt://${authority}:${split.port}?streamid=${encodeURIComponent(streamid)}`,
    host: split.host,
    port: split.port,
    mode: 'caller',
    source: 'srt-relay',
    streamid,
  };
}
