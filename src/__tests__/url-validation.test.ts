import { describe, it, expect } from 'vitest';
import { graphicUrl, httpUrlOnly, srtUrl } from '../lib/url-validation.js';

describe('graphicUrl', () => {
  it('accepts https:// URLs', () => {
    expect(() => graphicUrl('https://example.com/overlay.png')).not.toThrow();
  });

  it('accepts http:// URLs', () => {
    expect(() => graphicUrl('http://example.com/overlay')).not.toThrow();
  });

  it('accepts data:image/png URIs', () => {
    expect(() => graphicUrl('data:image/png;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/jpeg URIs', () => {
    expect(() => graphicUrl('data:image/jpeg;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/gif URIs', () => {
    expect(() => graphicUrl('data:image/gif;base64,abc123')).not.toThrow();
  });

  it('accepts data:image/webp URIs', () => {
    expect(() => graphicUrl('data:image/webp;base64,abc123')).not.toThrow();
  });

  it('rejects data:text/html URIs (JS execution risk in CEF)', () => {
    expect(() =>
      graphicUrl('data:text/html,<html><script>alert(1)</script></html>')
    ).toThrow();
  });

  it('rejects data:text/html with encoded payload', () => {
    expect(() =>
      graphicUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')
    ).toThrow();
  });

  it('rejects file:// URLs', () => {
    expect(() => graphicUrl('file:///etc/passwd')).toThrow();
  });

  it('rejects javascript: URLs', () => {
    expect(() => graphicUrl('javascript:alert(1)')).toThrow();
  });

  it('rejects data:application/* URIs', () => {
    expect(() => graphicUrl('data:application/json,{}')).toThrow();
  });

  it('rejects data:text/plain URIs', () => {
    expect(() => graphicUrl('data:text/plain,hello')).toThrow();
  });
});

describe('httpUrlOnly', () => {
  it('accepts https:// URLs', () => {
    expect(() => httpUrlOnly('https://example.com')).not.toThrow();
  });

  it('accepts http:// URLs', () => {
    expect(() => httpUrlOnly('http://example.com')).not.toThrow();
  });

  it('rejects ftp:// URLs', () => {
    expect(() => httpUrlOnly('ftp://example.com')).toThrow();
  });

  it('rejects invalid URLs', () => {
    expect(() => httpUrlOnly('not-a-url')).toThrow();
  });
});

describe('srtUrl', () => {
  it('accepts valid srt:// URLs', () => {
    expect(() => srtUrl('srt://example.com:9000')).not.toThrow();
  });

  it('rejects non-srt URLs', () => {
    expect(() => srtUrl('http://example.com')).toThrow();
  });
});
