/**
 * Tests for log redaction (issue #69).
 *
 * Verifies that redactSensitive() strips known-sensitive fields and that
 * safeFlowProjection() never emits block/element properties (which may carry
 * SRT URIs, passphrases, tokens, or credentials) into logs.
 */

import { describe, it, expect } from 'vitest';
import { redactSensitive, safeFlowProjection } from '../lib/log-redact.js';

describe('redactSensitive', () => {
  it('redacts top-level sensitive keys', () => {
    const out = redactSensitive({
      passphrase: 'sup3r-s3cret',
      token: 'ghp_abc123',
      secret: 'my-secret',
      name: 'cam-1',
    }) as Record<string, unknown>;

    expect(out.passphrase).toBe('[REDACTED]');
    expect(out.token).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.name).toBe('cam-1');
  });

  it('redacts nested sensitive values and matches key substrings', () => {
    const out = redactSensitive({
      block: {
        srt_uri: 'srt://host:1234?passphrase=leaked',
        streamid: 'live/cam1',
        authorization: 'Bearer xyz',
        label: 'ok',
      },
    }) as { block: Record<string, unknown> };

    expect(out.block.srt_uri).toBe('[REDACTED]');
    expect(out.block.streamid).toBe('[REDACTED]');
    expect(out.block.authorization).toBe('[REDACTED]');
    expect(out.block.label).toBe('ok');
  });

  it('does not leak the sensitive string anywhere in serialized output', () => {
    const secretValue = 'srt://h:9000?passphrase=TOPSECRET-PW';
    const out = redactSensitive({ nested: [{ srt_uri: secretValue }] });
    expect(JSON.stringify(out)).not.toContain('TOPSECRET-PW');
  });

  it('preserves non-object primitives', () => {
    expect(redactSensitive('plain')).toBe('plain');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBe(null);
  });
});

describe('safeFlowProjection', () => {
  it('keeps only IDs/types and never emits block or element properties', () => {
    const flow = {
      blocks: [
        {
          id: 'blk-1',
          block_definition_id: 'srt.input',
          properties: { srt_uri: 'srt://h?passphrase=LEAKED-PW', streamid: 'live/1' },
        },
      ],
      elements: [
        { id: 'el-1', element_type: 'video', config: { token: 'LEAKED-TOKEN' } },
      ],
      links: [{ id: 'lnk-1' }],
    };

    const out = safeFlowProjection(flow) as Record<string, unknown>;
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('LEAKED-PW');
    expect(serialized).not.toContain('LEAKED-TOKEN');
    expect(serialized).not.toContain('passphrase');
    expect(out.blockCount).toBe(1);
    expect(out.elementCount).toBe(1);
    expect(out.linkCount).toBe(1);
    expect((out.blocks as Record<string, unknown>[])[0]).toEqual({
      id: 'blk-1',
      block_definition_id: 'srt.input',
    });
    expect((out.elements as Record<string, unknown>[])[0]).toEqual({
      id: 'el-1',
      element_type: 'video',
    });
  });

  it('handles missing arrays gracefully', () => {
    const out = safeFlowProjection({}) as Record<string, unknown>;
    expect(out.blockCount).toBe(0);
    expect(out.elementCount).toBe(0);
    expect(out.linkCount).toBe(0);
    expect(out.blocks).toEqual([]);
    expect(out.elements).toEqual([]);
  });
});
