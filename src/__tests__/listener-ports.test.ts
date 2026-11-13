/**
 * The pure parts of port assignment inside the reserved port set.
 */

import { describe, it, expect } from 'vitest';
import type { PortReservation } from '../lib/strom.js';
import {
  clashesAfterWrite,
  listenerPortRequest,
  lowestFreePort,
  resolveListenerAddress,
  resolveSrtAddress,
  srtClashAfterWrite,
  withListenerPort,
} from '../services/listener-ports.js';
import type { ListenerPortUse, SrtBindings } from '../services/listener-ports.js';

const RESERVATION: PortReservation = {
  id: 'lease-1',
  owner_id: 'test',
  ports: [47100, 47101, 47102, 47103, 47104],
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};
const reserved = { status: 'reserved' as const, reservation: RESERVATION };
const used: ListenerPortUse[] = [
  { kind: 'source', id: 's1', name: 'Cam 1', port: 47100 },
  { kind: 'output', id: 'o1', name: 'Program', port: 47102 },
];

describe('listenerPortRequest', () => {
  it('reads the port, with 0 meaning assign', () => {
    expect(listenerPortRequest('srt://:47100?mode=listener')).toBe(47100);
    expect(listenerPortRequest('srt://:0?mode=listener&passphrase=abc')).toBe(0);
    expect(listenerPortRequest('srt://:0')).toBe(0);
  });
  it('is null for anything that binds nothing here', () => {
    expect(listenerPortRequest('srt://cdn.example.com:9000?mode=caller')).toBeNull();
    expect(listenerPortRequest('srt://:9000?mode=caller')).toBeNull();
    expect(listenerPortRequest('https://example.com')).toBeNull();
    expect(listenerPortRequest('srt://:70000')).toBeNull();
  });
});

describe('withListenerPort', () => {
  it('replaces only the port', () => {
    expect(withListenerPort('srt://:0?mode=listener&latency=200', 47103)).toBe('srt://:47103?mode=listener&latency=200');
    expect(withListenerPort(' srt://:47100 ', 47101)).toBe('srt://:47101');
  });
});

describe('lowestFreePort', () => {
  it('finds the first gap and reports a full range', () => {
    expect(lowestFreePort(RESERVATION.ports, new Set([47100, 47101]))).toBe(47102);
    expect(lowestFreePort(RESERVATION.ports, new Set([47100, 47101, 47102, 47103, 47104]))).toBeNull();
  });
});

describe('resolveListenerAddress', () => {
  it('passes non-listener addresses through', () => {
    expect(resolveListenerAddress('srt://cdn.example.com:9000?mode=caller', reserved, used)).toEqual({
      ok: true, address: 'srt://cdn.example.com:9000?mode=caller', port: null,
    });
  });

  it('assigns the lowest free port, skipping sources and outputs alike', () => {
    expect(resolveListenerAddress('srt://:0?mode=listener', reserved, used)).toEqual({
      ok: true, address: 'srt://:47101?mode=listener', port: 47101,
    });
  });

  it('keeps a valid current port on an assignment request', () => {
    const r = resolveListenerAddress('srt://:0?mode=listener', reserved, used, { exclude: { kind: 'source', id: 's1' }, keep: 47100 });
    expect(r).toEqual({ ok: true, address: 'srt://:47100?mode=listener', port: 47100 });
  });

  it('does not keep a current port that is now out of range or taken', () => {
    const out = resolveListenerAddress('srt://:0', reserved, used, { keep: 9000 });
    expect(out).toMatchObject({ ok: true, port: 47101 });
    const taken = resolveListenerAddress('srt://:0', reserved, used, { exclude: { kind: 'source', id: 'other' }, keep: 47102 });
    expect(taken).toMatchObject({ ok: true, port: 47101 });
  });

  it('refuses an explicit port outside the range, or held by someone else', () => {
    expect(resolveListenerAddress('srt://:9000?mode=listener', reserved, used)).toMatchObject({ ok: false, statusCode: 422 });
    const held = resolveListenerAddress('srt://:47102?mode=listener', reserved, used);
    expect(held).toMatchObject({ ok: false, statusCode: 409 });
    expect((held as { error: string }).error).toContain('output "Program"');
  });

  it('lets a document keep its own explicit port', () => {
    expect(resolveListenerAddress('srt://:47100?mode=listener', reserved, used, { exclude: { kind: 'source', id: 's1' } }))
      .toMatchObject({ ok: true, port: 47100 });
  });

  it('answers 409 when nothing is free', () => {
    const full: ListenerPortUse[] = [47100, 47101, 47102, 47103, 47104].map((port, i) => ({ kind: 'source', id: `s${i}`, name: `S${i}`, port }));
    expect(resolveListenerAddress('srt://:0', reserved, full)).toMatchObject({ ok: false, statusCode: 409 });
  });

  it('waits while the lease is pending, for explicit and assigned ports alike', () => {
    expect(resolveListenerAddress('srt://:0', { status: 'pending' }, [])).toMatchObject({ ok: false, statusCode: 503 });
    expect(resolveListenerAddress('srt://:47100', { status: 'pending' }, [])).toMatchObject({ ok: false, statusCode: 503 });
  });

  it('without a range: explicit ports only need to be unique, and nothing can be assigned', () => {
    for (const status of ['unsupported', 'disabled'] as const) {
      expect(resolveListenerAddress('srt://:47100', { status }, used)).toMatchObject({ ok: false, statusCode: 409 });
      expect(resolveListenerAddress('srt://:9000', { status }, used)).toMatchObject({ ok: true, port: 9000 });
      expect(resolveListenerAddress('srt://:0', { status }, used)).toMatchObject({ ok: false, statusCode: 400 });
    }
  });
});

describe('clashesAfterWrite', () => {
  it('finds another holder of our port but not ourselves', () => {
    expect(clashesAfterWrite(used, { kind: 'source', id: 's1' }, 47100)).toBeUndefined();
    expect(clashesAfterWrite(used, { kind: 'source', id: 'me' }, 47100)?.id).toBe('s1');
  });
});

describe('resolveSrtAddress (one resolver for ports and relay ids)', () => {
  const bindings: SrtBindings = {
    ports: used,
    relayIds: [{ kind: 'output', id: 'o2', name: 'Feed', relayId: 'held-by-output-0123' }],
  };

  it('resolves listener addresses as resolveListenerAddress does, keeping the stored port', () => {
    expect(resolveSrtAddress('srt://:0', reserved, bindings, { self: { kind: 'source', id: 's9' }, keepFrom: 'srt://:47103?mode=listener' }))
      .toEqual({ ok: true, address: 'srt://:47103', port: 47103, relayId: null, assigned: true });
    expect(resolveSrtAddress('srt://:47100', reserved, bindings)).toMatchObject({ ok: false, statusCode: 409 });
    expect(resolveSrtAddress('srt://cdn.example.com:9000', reserved, bindings)).toMatchObject({ ok: true, port: null, relayId: null, assigned: false });
  });

  it('generates a relay id for auto, keeps a stored one (and its passphrase), and binds no port', () => {
    const r = resolveSrtAddress('srt+relay://auto?latency=200', { status: 'pending' }, bindings);
    expect(r).toMatchObject({ ok: true, port: null, assigned: true });
    expect(r.ok && r.relayId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, { keepFrom: 'srt+relay://kept-id-0123456789?passphrase=encv1:x' }))
      .toEqual({ ok: true, address: 'srt+relay://kept-id-0123456789?passphrase=encv1:x', port: null, relayId: 'kept-id-0123456789', assigned: true });
  });

  it('refuses a relay id another document holds, but not its own', () => {
    expect(resolveSrtAddress('srt+relay://held-by-output-0123', reserved, bindings)).toMatchObject({ ok: false, statusCode: 409 });
    expect(resolveSrtAddress('srt+relay://held-by-output-0123', reserved, bindings, { self: { kind: 'output', id: 'o2' } })).toMatchObject({ ok: true });
  });

  const caps = (state: 'ok' | 'unsupported' | 'unreachable' | 'unknown', names: string[]) => ({
    state,
    srt: { modes: { listener: true, caller: true, rendezvous: true }, relays: names.map((name) => ({ name, public: `${name}.example.com:9000` })) },
  });

  it('refuses relay addresses only when Strom positively reports no relay (or is too old to have any)', () => {
    for (const state of ['ok', 'unsupported'] as const) {
      expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, { strom: caps(state, []) }))
        .toMatchObject({ ok: false, statusCode: 422, code: 'srt-relay-not-configured', relays: [] });
    }
    for (const state of ['unreachable', 'unknown'] as const) {
      expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, { strom: caps(state, []) })).toMatchObject({ ok: true });
    }
  });

  it('refuses a relay name Strom definitely does not have, naming the ones it has', () => {
    const r = resolveSrtAddress('srt+relay://auto@us', reserved, bindings, { strom: caps('ok', ['default', 'eu-north']) });
    expect(r).toMatchObject({ ok: false, statusCode: 422, code: 'srt-relay-unknown', relays: ['default', 'eu-north'] });
    expect(!r.ok && r.error).toMatch(/no SRT relay named "us"; configured: default, eu-north/);
    // Without @ the address wants `default`.
    expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, { strom: caps('ok', ['eu-north']) }))
      .toMatchObject({ ok: false, code: 'srt-relay-unknown' });
    expect(resolveSrtAddress('srt+relay://auto@eu-north', reserved, bindings, { strom: caps('ok', ['default', 'eu-north']) }))
      .toMatchObject({ ok: true });
    expect(resolveSrtAddress('srt+relay://auto@us', reserved, bindings, { strom: caps('unreachable', ['default']) }))
      .toMatchObject({ ok: true });
  });

  it('checks the relay a kept auto address ends up on', () => {
    // `auto` without @ keeps the stored relay, so that is the one checked.
    expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, {
      keepFrom: 'srt+relay://kept-id-0123456789@eu-north',
      strom: caps('ok', ['default', 'eu-north']),
    })).toMatchObject({ ok: true, address: 'srt+relay://kept-id-0123456789@eu-north' });
    expect(resolveSrtAddress('srt+relay://auto', reserved, bindings, {
      keepFrom: 'srt+relay://kept-id-0123456789@gone',
      strom: caps('ok', ['default']),
    })).toMatchObject({ ok: false, code: 'srt-relay-unknown' });
  });

  it('srtClashAfterWrite reports a port or relay id another document now holds', () => {
    expect(srtClashAfterWrite(bindings, { kind: 'source', id: 'me' }, { port: null, relayId: 'held-by-output-0123' })).toMatch(/output "Feed"/);
    expect(srtClashAfterWrite(bindings, { kind: 'source', id: 'me' }, { port: 47100, relayId: null })).toMatch(/port 47100 .*source "Cam 1"/);
    expect(srtClashAfterWrite(bindings, { kind: 'source', id: 's1' }, { port: 47100, relayId: null })).toBeUndefined();
  });
});
