/**
 * Unit tests for compute-on-read gateway health derivation (issue #263,
 * `docs/specs/studio-gateways.md` §"Health derivation").
 *
 * Health is never persisted — derived from `lastSeenAt` with the OL-4
 * `healthy | down | unknown` vocabulary (no `degraded`). Default down-after is
 * 15s.
 */

import { describe, it, expect } from 'vitest';
import { deriveGatewayHealth, gatewayToApi } from '../lib/gateway-health.js';
import type { GatewayDoc } from '../db/types.js';

const NOW = new Date('2026-09-15T18:31:12.400Z');

describe('deriveGatewayHealth', () => {
  it('is unknown when never contacted', () => {
    expect(deriveGatewayHealth(null, NOW)).toBe('unknown');
    expect(deriveGatewayHealth(undefined, NOW)).toBe('unknown');
    expect(deriveGatewayHealth('not-a-date', NOW)).toBe('unknown');
  });

  it('is healthy within the down-after threshold', () => {
    const seen = new Date(NOW.getTime() - 5_000).toISOString(); // 5s ago
    expect(deriveGatewayHealth(seen, NOW)).toBe('healthy');
  });

  it('is healthy exactly at the threshold boundary', () => {
    const seen = new Date(NOW.getTime() - 15_000).toISOString(); // exactly 15s
    expect(deriveGatewayHealth(seen, NOW)).toBe('healthy');
  });

  it('is down past the threshold', () => {
    const seen = new Date(NOW.getTime() - 16_000).toISOString(); // 16s ago
    expect(deriveGatewayHealth(seen, NOW)).toBe('down');
  });

  it('never returns degraded', () => {
    for (const ageMs of [0, 5_000, 15_000, 60_000, 3_600_000]) {
      const seen = new Date(NOW.getTime() - ageMs).toISOString();
      expect(deriveGatewayHealth(seen, NOW)).not.toBe('degraded');
    }
  });
});

describe('gatewayToApi', () => {
  it('strips internal fields and the token hash, and attaches derived health', () => {
    const doc: GatewayDoc = {
      _id: 'gw-1',
      _rev: '1-abc',
      type: 'gateway',
      name: 'Venue A',
      tokenHash: 'a'.repeat(64),
      lastSeenAt: new Date(NOW.getTime() - 3_000).toISOString(),
      host: 'venue-a.local',
      stromVersion: '0.42.1',
      deviceCount: 4,
      streamingCount: 2,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const api = gatewayToApi(doc, NOW) as unknown as Record<string, unknown>;
    expect(api.id).toBe('gw-1');
    expect(api.health).toBe('healthy');
    expect(api.host).toBe('venue-a.local');
    // internal / secret fields never leak
    expect(api._id).toBeUndefined();
    expect(api._rev).toBeUndefined();
    expect(api.type).toBeUndefined();
    expect(api.tokenHash).toBeUndefined();
    expect(api.token).toBeUndefined();
  });
});
