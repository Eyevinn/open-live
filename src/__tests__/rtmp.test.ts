/**
 * Unit tests for RTMP presets + credential validation (spec:
 * rtmp-multi-destination.md, ADR-004 security conditions 2/4/5/6).
 */

import { describe, it, expect } from 'vitest';
import {
  RTMP_PRESETS,
  resolveIngestUrl,
  validateCustomIngestUrl,
  validateStreamKey,
  composeRtmpUrl,
} from '../lib/rtmp.js';

describe('resolveIngestUrl — named presets resolve from the static table only', () => {
  it('resolves youtube/twitch/facebook from the table, ignoring any client ingestUrl', () => {
    expect(resolveIngestUrl('youtube')).toBe(RTMP_PRESETS.youtube.ingestUrl);
    expect(resolveIngestUrl('twitch')).toBe(RTMP_PRESETS.twitch.ingestUrl);
    expect(resolveIngestUrl('facebook')).toBe(RTMP_PRESETS.facebook.ingestUrl);
    // A client-supplied ingestUrl on a named preset must NOT repoint it.
    expect(resolveIngestUrl('youtube', 'rtmp://attacker.example.com/app')).toBe(
      RTMP_PRESETS.youtube.ingestUrl,
    );
  });

  it('returns the validated operator URL for custom', () => {
    expect(resolveIngestUrl('custom', 'rtmps://ingest.example.com:1935/app')).toBe(
      'rtmps://ingest.example.com:1935/app',
    );
  });

  it('throws when custom is missing its ingestUrl', () => {
    expect(() => resolveIngestUrl('custom')).toThrow();
  });
});

describe('validateCustomIngestUrl — rtmp(s) scheme + SSRF discipline', () => {
  it('accepts rtmp:// and rtmps:// public hosts', () => {
    expect(() => validateCustomIngestUrl('rtmp://ingest.example.com/app')).not.toThrow();
    expect(() => validateCustomIngestUrl('rtmps://ingest.example.com:443/app')).not.toThrow();
  });

  it('rejects every non-rtmp(s) scheme with a clear error (condition 5)', () => {
    for (const bad of [
      'http://evil.example.com/x',
      'https://evil.example.com/x',
      'file:///etc/passwd',
      'srt://host:9000',
      'javascript:alert(1)',
      'gopher://host/x',
      'ftp://host/x',
    ]) {
      expect(() => validateCustomIngestUrl(bad), bad).toThrow();
    }
  });

  it('rejects private/loopback/link-local/internal hosts (SSRF)', () => {
    for (const bad of [
      'rtmp://127.0.0.1/app',
      'rtmp://10.0.0.5/app',
      'rtmp://192.168.1.1/app',
      'rtmp://169.254.169.254/app',
      'rtmp://[::1]/app',
      'rtmp://localhost/app',
      'rtmp://metadata.google.internal/app',
    ]) {
      expect(() => validateCustomIngestUrl(bad), bad).toThrow();
    }
  });

  it('rejects control chars and over-length URLs', () => {
    expect(() => validateCustomIngestUrl('rtmp://host/app\n')).toThrow();
    expect(() => validateCustomIngestUrl('rtmp://host/' + 'a'.repeat(600))).toThrow();
  });
});

describe('validateStreamKey', () => {
  it('accepts a normal platform key', () => {
    expect(() => validateStreamKey('abcd-1234-efgh-5678')).not.toThrow();
  });

  it('rejects an empty key (condition 6)', () => {
    expect(() => validateStreamKey('')).toThrow();
  });

  it('rejects whitespace / newlines / control chars (condition 6)', () => {
    expect(() => validateStreamKey('has space')).toThrow();
    expect(() => validateStreamKey('has\nnewline')).toThrow();
    expect(() => validateStreamKey('has\ttab')).toThrow();
  });

  it('rejects an over-length key', () => {
    expect(() => validateStreamKey('a'.repeat(600))).toThrow();
  });

  it('rejects a key beginning with the reserved encv1: prefix (condition 4)', () => {
    expect(() => validateStreamKey('encv1:AAAABBBB')).toThrow(/encv1/);
  });
});

describe('composeRtmpUrl', () => {
  it('joins ingest URL and key with a single slash', () => {
    expect(composeRtmpUrl('rtmps://a.rtmp.youtube.com/live2', 'KEY')).toBe(
      'rtmps://a.rtmp.youtube.com/live2/KEY',
    );
  });

  it('does not double the slash when the ingest URL has a trailing slash', () => {
    expect(composeRtmpUrl('rtmp://live.twitch.tv/app/', 'KEY')).toBe('rtmp://live.twitch.tv/app/KEY');
  });
});
