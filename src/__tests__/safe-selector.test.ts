import { describe, it, expect } from 'vitest';
import { safeSelector, MangoInjectionError, withTypeGuard } from '../db/index.js';
import type Nano from 'nano';
import type { ProductionDoc } from '../db/types.js';

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

describe('findTrusted (#257)', () => {
  /** Minimal stand-in for a nano DocumentScope that records find() calls. */
  function makeScope() {
    const calls: unknown[] = [];
    const scope = {
      get: async () => ({ type: 'production' }),
      find: async (query: unknown) => {
        calls.push(query);
        return { docs: [] };
      },
    } as unknown as Nano.DocumentScope<ProductionDoc>;
    return { scope, calls };
  }

  it('passes an operator selector through to CouchDB untouched', async () => {
    const { scope, calls } = makeScope();
    const db = withTypeGuard(scope, 'production');
    const query = {
      selector: { type: 'production', status: { $in: ['active', 'activating'] } },
    };

    await expect(db.findTrusted(query)).resolves.toEqual({ docs: [] });
    expect(calls[0]).toEqual(query);
  });

  it('still rejects the same selector via plain find()', () => {
    const { scope } = makeScope();
    const db = withTypeGuard(scope, 'production');

    expect(() =>
      db.find({ selector: { type: 'production', status: { $in: ['active'] } } }),
    ).toThrow(MangoInjectionError);
  });

  it('does not let a user-derived selector reach CouchDB through find()', () => {
    const { scope, calls } = makeScope();
    const db = withTypeGuard(scope, 'production');

    expect(() =>
      db.find({ selector: { name: { $regex: '(a+)+$' } } as Nano.MangoSelector }),
    ).toThrow(/\$regex/);
    expect(calls).toHaveLength(0);
  });
});
