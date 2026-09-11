import { describe, it, expect } from 'vitest';
import { safeSelector, MangoInjectionError } from '../db/index.js';

describe('safeSelector', () => {
  it('passes a hardcoded scalar selector through unchanged', () => {
    const selector = { type: 'production' };
    expect(safeSelector(selector)).toBe(selector);
  });

  it('passes a nested selector with no operators through unchanged', () => {
    const selector = { type: 'source', meta: { tags: ['live', 'studio'] } };
    expect(() => safeSelector(selector)).not.toThrow();
  });

  it('rejects a top-level Mango operator key ($in)', () => {
    expect(() => safeSelector({ type: { $in: ['production', 'source'] } })).toThrow(
      MangoInjectionError,
    );
  });

  it('rejects a $regex operator smuggled into a value', () => {
    expect(() => safeSelector({ name: { $regex: '.*' } })).toThrow(MangoInjectionError);
  });

  it('rejects a logical $or operator', () => {
    expect(() =>
      safeSelector({ $or: [{ type: 'production' }, { type: 'source' }] }),
    ).toThrow(MangoInjectionError);
  });

  it('rejects an operator nested inside an array element', () => {
    expect(() =>
      safeSelector({ $and: [{ type: 'production' }] }),
    ).toThrow(/\$and/);
  });

  it('tolerates null and undefined selectors (no-op)', () => {
    expect(() => safeSelector(null)).not.toThrow();
    expect(() => safeSelector(undefined)).not.toThrow();
  });
});
