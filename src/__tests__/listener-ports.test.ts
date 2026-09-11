/**
 * The pure parts of port assignment inside the leased block.
 */

import { describe, it, expect } from 'vitest';
import type { PortLease } from '../lib/strom.js';
import {
  clashesAfterWrite,
  listenerPortRequest,
  lowestFreePort,
  resolveListenerAddress,
  withListenerPort,
} from '../services/listener-ports.js';
import type { ListenerPortUse } from '../services/listener-ports.js';

const LEASE: PortLease = {
  id: 'lease-1',
  client_id: 'test',
  first_port: 47100,
  last_port: 47104,
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-01-01T00:10:00Z',
};
const leased = { status: 'leased' as const, lease: LEASE };
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
    expect(lowestFreePort(LEASE, new Set([47100, 47101]))).toBe(47102);
    expect(lowestFreePort(LEASE, new Set([47100, 47101, 47102, 47103, 47104]))).toBeNull();
  });
});

describe('resolveListenerAddress', () => {
  it('passes non-listener addresses through', () => {
    expect(resolveListenerAddress('srt://cdn.example.com:9000?mode=caller', leased, used)).toEqual({
      ok: true, address: 'srt://cdn.example.com:9000?mode=caller', port: null,
    });
  });

  it('assigns the lowest free port, skipping sources and outputs alike', () => {
    expect(resolveListenerAddress('srt://:0?mode=listener', leased, used)).toEqual({
      ok: true, address: 'srt://:47101?mode=listener', port: 47101,
    });
  });

  it('keeps a valid current port on an assignment request', () => {
    const r = resolveListenerAddress('srt://:0?mode=listener', leased, used, { exclude: { kind: 'source', id: 's1' }, keep: 47100 });
    expect(r).toEqual({ ok: true, address: 'srt://:47100?mode=listener', port: 47100 });
  });

  it('does not keep a current port that is now out of range or taken', () => {
    const out = resolveListenerAddress('srt://:0', leased, used, { keep: 9000 });
    expect(out).toMatchObject({ ok: true, port: 47101 });
    const taken = resolveListenerAddress('srt://:0', leased, used, { exclude: { kind: 'source', id: 'other' }, keep: 47102 });
    expect(taken).toMatchObject({ ok: true, port: 47101 });
  });

  it('refuses an explicit port outside the range, or held by someone else', () => {
    expect(resolveListenerAddress('srt://:9000?mode=listener', leased, used)).toMatchObject({ ok: false, statusCode: 422 });
    const held = resolveListenerAddress('srt://:47102?mode=listener', leased, used);
    expect(held).toMatchObject({ ok: false, statusCode: 409 });
    expect((held as { error: string }).error).toContain('output "Program"');
  });

  it('lets a document keep its own explicit port', () => {
    expect(resolveListenerAddress('srt://:47100?mode=listener', leased, used, { exclude: { kind: 'source', id: 's1' } }))
      .toMatchObject({ ok: true, port: 47100 });
  });

  it('answers 409 when nothing is free', () => {
    const full: ListenerPortUse[] = [47100, 47101, 47102, 47103, 47104].map((port, i) => ({ kind: 'source', id: `s${i}`, name: `S${i}`, port }));
    expect(resolveListenerAddress('srt://:0', leased, full)).toMatchObject({ ok: false, statusCode: 409 });
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
