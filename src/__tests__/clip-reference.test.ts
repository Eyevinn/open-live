import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  clipReferenceSchema,
  validateClipReference,
  parseClipReference,
  serializeClipReference,
  deserializeClipReference,
  ClipReferenceNotImplementedError,
} from '../lib/clip-reference.js';
import type { ClipReference } from '../db/types.js';

describe('clipReferenceSchema (shape)', () => {
  it('accepts a minimal url reference', () => {
    const ref = clipReferenceSchema.parse({ type: 'url', url: 'https://cdn.example.com/clip.mp4' });
    expect(ref).toEqual({ type: 'url', url: 'https://cdn.example.com/clip.mp4' });
  });

  it('accepts a url reference with an optional timerange', () => {
    const ref = clipReferenceSchema.parse({
      type: 'url',
      url: 'https://cdn.example.com/clip.mp4',
      timerange: '[0:0_10:0)',
    });
    expect(ref.type).toBe('url');
  });

  it('accepts an s3 reference', () => {
    const ref = clipReferenceSchema.parse({ type: 's3', bucket: 'clips', key: 'shows/a.mp4' });
    expect(ref).toEqual({ type: 's3', bucket: 'clips', key: 'shows/a.mp4' });
  });

  it('accepts a tams reference at the type/shape level (reserved)', () => {
    const ref = clipReferenceSchema.parse({
      type: 'tams',
      store: 'https://tams.example.com',
      flowId: 'flow-1',
      timerange: '[0:0_10:0)',
    });
    expect(ref.type).toBe('tams');
  });

  it('rejects an unknown discriminant', () => {
    expect(() => clipReferenceSchema.parse({ type: 'ftp', url: 'x' })).toThrow(z.ZodError);
  });

  it('rejects a url reference missing url', () => {
    expect(() => clipReferenceSchema.parse({ type: 'url' })).toThrow(z.ZodError);
  });

  it('rejects an s3 reference missing key', () => {
    expect(() => clipReferenceSchema.parse({ type: 's3', bucket: 'clips' })).toThrow(z.ZodError);
  });

  it('rejects a tams reference missing the required timerange', () => {
    expect(() =>
      clipReferenceSchema.parse({ type: 'tams', store: 's', flowId: 'f' }),
    ).toThrow(z.ZodError);
  });
});

describe('validateClipReference (semantics)', () => {
  it('accepts a public https url', () => {
    expect(() => validateClipReference({ type: 'url', url: 'https://cdn.example.com/c.mp4' })).not.toThrow();
  });

  it('rejects a url pointing at a private IP (SSRF)', () => {
    expect(() => validateClipReference({ type: 'url', url: 'http://169.254.169.254/latest' })).toThrow();
  });

  it('rejects a url with a disallowed scheme', () => {
    expect(() => validateClipReference({ type: 'url', url: 'file:///etc/passwd' })).toThrow();
  });

  it('rejects a url targeting localhost', () => {
    expect(() => validateClipReference({ type: 'url', url: 'http://localhost:9000/c.mp4' })).toThrow();
  });

  it('accepts a valid s3 bucket/key', () => {
    expect(() => validateClipReference({ type: 's3', bucket: 'my-clips', key: 'a/b.mp4' })).not.toThrow();
  });

  it('rejects an s3 bucket with uppercase / invalid chars', () => {
    expect(() => validateClipReference({ type: 's3', bucket: 'My_Clips', key: 'a.mp4' })).toThrow();
  });

  it('rejects an s3 bucket shaped like an IP address', () => {
    expect(() => validateClipReference({ type: 's3', bucket: '10.0.0.1', key: 'a.mp4' })).toThrow();
  });

  it('rejects an s3 key with a leading slash', () => {
    expect(() => validateClipReference({ type: 's3', bucket: 'clips', key: '/a.mp4' })).toThrow();
  });

  it('rejects an s3 key with control characters', () => {
    expect(() => validateClipReference({ type: 's3', bucket: 'clips', key: 'a\n.mp4' })).toThrow();
  });

  it('rejects tams with a 501-style not-implemented error', () => {
    expect(() =>
      validateClipReference({ type: 'tams', store: 's', flowId: 'f', timerange: '[0_1)' }),
    ).toThrow(ClipReferenceNotImplementedError);
    try {
      validateClipReference({ type: 'tams', store: 's', flowId: 'f', timerange: '[0_1)' });
    } catch (err) {
      expect(err).toBeInstanceOf(ClipReferenceNotImplementedError);
      expect((err as ClipReferenceNotImplementedError).statusCode).toBe(501);
    }
  });
});

describe('serialize / deserialize round-trip', () => {
  const cases: ClipReference[] = [
    { type: 'url', url: 'https://cdn.example.com/c.mp4' },
    { type: 'url', url: 'https://cdn.example.com/c.mp4', timerange: '[0:0_10:0)' },
    { type: 's3', bucket: 'clips', key: 'shows/a.mp4' },
    { type: 's3', bucket: 'clips', key: 'shows/a.mp4', timerange: '[0:0_5:0)' },
  ];

  it.each(cases)('round-trips %o through JSON', (ref) => {
    const s = serializeClipReference(ref);
    expect(typeof s).toBe('string');
    expect(deserializeClipReference(s)).toEqual(ref);
  });

  it('never serializes an invalid (private-IP) url reference', () => {
    expect(() => serializeClipReference({ type: 'url', url: 'http://127.0.0.1/c.mp4' })).toThrow();
  });

  it('never serializes a tams reference in v1', () => {
    expect(() =>
      serializeClipReference({ type: 'tams', store: 's', flowId: 'f', timerange: '[0_1)' }),
    ).toThrow(ClipReferenceNotImplementedError);
  });

  it('rejects deserializing non-JSON', () => {
    expect(() => deserializeClipReference('not json')).toThrow(/not valid JSON/);
  });

  it('rejects deserializing a malformed-shape reference', () => {
    expect(() => deserializeClipReference(JSON.stringify({ type: 'url' }))).toThrow(z.ZodError);
  });

  it('rejects deserializing a semantically-invalid reference', () => {
    expect(() =>
      deserializeClipReference(JSON.stringify({ type: 'url', url: 'http://localhost/c.mp4' })),
    ).toThrow();
  });
});

describe('parseClipReference', () => {
  it('parses and validates in one step', () => {
    expect(parseClipReference({ type: 'url', url: 'https://cdn.example.com/c.mp4' })).toEqual({
      type: 'url',
      url: 'https://cdn.example.com/c.mp4',
    });
  });

  it('throws on a bad shape', () => {
    expect(() => parseClipReference({ type: 'url' })).toThrow(z.ZodError);
  });

  it('throws on a bad semantic value', () => {
    expect(() => parseClipReference({ type: 'url', url: 'file:///x' })).toThrow();
  });
});
