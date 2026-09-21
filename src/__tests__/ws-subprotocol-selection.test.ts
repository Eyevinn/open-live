/**
 * Tests for selectWsSubprotocol (open-live-studio#144).
 *
 * The browser WebSocket API fails the connection if the client offered
 * subprotocols and the server's handshake response doesn't echo one of them
 * back (#49). This server recognizes two bearer markers:
 *   - `openlive.bearer` — this app's own self-hosted API_KEY scheme (#49),
 *     whose key is checked separately in the onRequest auth hook.
 *   - `osc.bearer` — the OSC platform ingress gate's WS-upgrade auth
 *     convention (osaas-lib-orchestrator#263), whose SAT is validated
 *     upstream by the gate before the request reaches this server; this app
 *     only needs to echo the marker so the handshake completes.
 *
 * selectWsSubprotocol must select whichever recognized marker is offered, and
 * never select (or otherwise leak) a caller-supplied key-bearing subprotocol
 * (`openlive.bearer.<key>` / `osc.bearer.<token>`) itself — only the plain
 * marker is ever echoed back.
 */

import { describe, it, expect } from 'vitest';
import { selectWsSubprotocol } from '../server.js';

describe('selectWsSubprotocol (#144)', () => {
  it('selects openlive.bearer when offered with its key', () => {
    const protocols = new Set(['openlive.bearer', 'openlive.bearer.some-api-key']);
    expect(selectWsSubprotocol(protocols)).toBe('openlive.bearer');
  });

  it('selects osc.bearer when offered with its token', () => {
    const protocols = new Set(['osc.bearer', 'osc.bearer.some-sat-jwt']);
    expect(selectWsSubprotocol(protocols)).toBe('osc.bearer');
  });

  it('selects osc.bearer when offered alone (no key subprotocol)', () => {
    const protocols = new Set(['osc.bearer']);
    expect(selectWsSubprotocol(protocols)).toBe('osc.bearer');
  });

  it('prefers openlive.bearer when both markers are somehow offered', () => {
    const protocols = new Set(['openlive.bearer', 'osc.bearer']);
    expect(selectWsSubprotocol(protocols)).toBe('openlive.bearer');
  });

  it('never selects the key-bearing subprotocol itself', () => {
    const protocols = new Set(['openlive.bearer.some-api-key']);
    expect(selectWsSubprotocol(protocols)).not.toBe('openlive.bearer.some-api-key');
    expect(selectWsSubprotocol(new Set(['osc.bearer.some-sat-jwt']))).not.toBe(
      'osc.bearer.some-sat-jwt',
    );
  });

  it('selects nothing when no recognized subprotocol is offered', () => {
    expect(selectWsSubprotocol(new Set())).toBe(false);
    expect(selectWsSubprotocol(new Set(['some-other-protocol']))).toBe(false);
  });
});
