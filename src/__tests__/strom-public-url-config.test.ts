import { afterEach, describe, expect, it } from 'vitest';
import { buildStromPublicUrl } from '../config.js';

describe('buildStromPublicUrl', () => {
  const original = process.env['STROM_PUBLIC_URL'];

  afterEach(() => {
    if (original === undefined) delete process.env['STROM_PUBLIC_URL'];
    else process.env['STROM_PUBLIC_URL'] = original;
  });

  it('is undefined when unset or blank', () => {
    delete process.env['STROM_PUBLIC_URL'];
    expect(buildStromPublicUrl()).toBeUndefined();
    process.env['STROM_PUBLIC_URL'] = '  ';
    expect(buildStromPublicUrl()).toBeUndefined();
  });

  it('strips trailing slashes from an http(s) URL', () => {
    process.env['STROM_PUBLIC_URL'] = 'https://strom.example.com/';
    expect(buildStromPublicUrl()).toBe('https://strom.example.com');
    process.env['STROM_PUBLIC_URL'] = 'http://localhost:8080/strom//';
    expect(buildStromPublicUrl()).toBe('http://localhost:8080/strom');
  });

  it.each([
    'strom.example.com',
    'strom.example.com:8080',
    'ftp://strom.example.com',
    'https:strom.example.com',
    'https:/strom.example.com',
  ])(
    'rejects %s with an error naming STROM_PUBLIC_URL',
    (value) => {
      process.env['STROM_PUBLIC_URL'] = value;
      expect(() => buildStromPublicUrl()).toThrow(/STROM_PUBLIC_URL.*http\(s\):\/\/host/);
    },
  );
});
