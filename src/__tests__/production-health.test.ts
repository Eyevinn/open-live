/**
 * Unit tests for the pure production-lifecycle + output-health helpers
 * (issue #255, spec docs/specs/production-lifecycle-health.md).
 *
 * These cover the transition rule (`stoppedStatus`), the output-health
 * derivation (`deriveOutputStatus` / `deriveOutputSnapshot`), and the WS
 * `PRODUCTION_STATUS` event builder — all with no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  stoppedStatus,
  deriveOutputStatus,
  deriveOutputSnapshot,
  buildProductionStatusEvent,
} from '../lib/production-health.js';

describe('stoppedStatus() — active→ended, never-active→inactive (spec §1)', () => {
  it('an active production that stops becomes ended', () => {
    expect(stoppedStatus('active')).toBe('ended');
  });

  it('an activating production that stops stays inactive (never broadcast)', () => {
    expect(stoppedStatus('activating')).toBe('inactive');
  });

  it('an inactive production stays inactive', () => {
    expect(stoppedStatus('inactive')).toBe('inactive');
  });

  it('an already-ended production reported again stays inactive-path (not re-ended from non-active)', () => {
    // Only an `active`→stop transition yields `ended`; a re-stop from a
    // non-active state must not fabricate `ended`.
    expect(stoppedStatus('ended')).toBe('inactive');
  });
});

describe('deriveOutputStatus() — healthy | down | unknown only (spec §2 / OQ-2)', () => {
  it('healthy when production active and flow running', () => {
    expect(deriveOutputStatus({ stromKnown: true, productionActive: true, flowRunning: true })).toBe('healthy');
  });

  it('down when production active but flow not running', () => {
    expect(deriveOutputStatus({ stromKnown: true, productionActive: true, flowRunning: false })).toBe('down');
  });

  it('down when production not active', () => {
    expect(deriveOutputStatus({ stromKnown: true, productionActive: false, flowRunning: false })).toBe('down');
  });

  it('unknown when Strom state could not be observed', () => {
    expect(deriveOutputStatus({ stromKnown: false, productionActive: true, flowRunning: true })).toBe('unknown');
  });

  it('never emits degraded (no verified per-output source today)', () => {
    const results = [
      deriveOutputStatus({ stromKnown: true, productionActive: true, flowRunning: true }),
      deriveOutputStatus({ stromKnown: true, productionActive: true, flowRunning: false }),
      deriveOutputStatus({ stromKnown: true, productionActive: false, flowRunning: false }),
      deriveOutputStatus({ stromKnown: false, productionActive: false, flowRunning: false }),
    ];
    expect(results).not.toContain('degraded');
  });
});

describe('deriveOutputSnapshot() — uniform flow-level status across outputs', () => {
  it('marks every assigned output healthy for a running, playing production', () => {
    const snap = deriveOutputSnapshot({
      outputIds: ['out-1', 'out-2'],
      stromKnown: true,
      productionActive: true,
      flowRunning: true,
    });
    expect(snap).toEqual([
      { id: 'out-1', status: 'healthy' },
      { id: 'out-2', status: 'healthy' },
    ]);
  });

  it('marks every assigned output down for a stopped production', () => {
    const snap = deriveOutputSnapshot({
      outputIds: ['out-1', 'out-2'],
      stromKnown: true,
      productionActive: false,
      flowRunning: false,
    });
    expect(snap.map((o) => o.status)).toEqual(['down', 'down']);
  });

  it('returns an empty snapshot for a production with no outputs', () => {
    expect(
      deriveOutputSnapshot({ outputIds: [], stromKnown: true, productionActive: true, flowRunning: true }),
    ).toEqual([]);
  });
});

describe('buildProductionStatusEvent() — WS lifecycle envelope (spec §3)', () => {
  it('carries type, productionId, status and the output snapshot; no ts/seq (stamped by broadcast layer)', () => {
    const evt = buildProductionStatusEvent('prod-abc', 'ended', [
      { id: 'out-1', status: 'down' },
    ]);
    expect(evt).toEqual({
      type: 'PRODUCTION_STATUS',
      productionId: 'prod-abc',
      status: 'ended',
      outputs: [{ id: 'out-1', status: 'down' }],
    });
    // ts is added centrally by broadcast(); seq rides the #209 envelope once it
    // lands — neither is fabricated here.
    expect('ts' in evt).toBe(false);
    expect('seq' in evt).toBe(false);
  });
});
