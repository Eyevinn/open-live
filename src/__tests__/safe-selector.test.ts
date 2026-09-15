import { describe, it, expect, vi } from 'vitest';
import type Nano from 'nano';
import { safeSelector, MangoInjectionError, withTypeGuard } from '../db/index.js';

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

interface TestDoc {
  type?: string;
}

function makeScope(): { scope: Nano.DocumentScope<TestDoc>; find: ReturnType<typeof vi.fn> } {
  const find = vi.fn().mockResolvedValue({ docs: [] });
  const scope = {
    get: vi.fn(),
    find,
  } as unknown as Nano.DocumentScope<TestDoc>;
  return { scope, find };
}

describe('withTypeGuard find/findTrusted guarding', () => {
  const operatorQuery: Nano.MangoQuery = {
    selector: { type: 'production', status: { $in: ['active', 'activating'] } },
  };

  it('find() still throws MangoInjectionError on a literal $in operator', () => {
    const { scope, find } = makeScope();
    const guarded = withTypeGuard(scope, 'production');
    expect(() => guarded.find(operatorQuery)).toThrow(MangoInjectionError);
    expect(find).not.toHaveBeenCalled();
  });

  it('find() still rejects $or, $regex, and operators nested in arrays/values', () => {
    const { scope } = makeScope();
    const guarded = withTypeGuard(scope, 'production');
    expect(() =>
      guarded.find({ selector: { $or: [{ type: 'production' }] } } as Nano.MangoQuery),
    ).toThrow(MangoInjectionError);
    expect(() =>
      guarded.find({ selector: { name: { $regex: '.*' } } } as Nano.MangoQuery),
    ).toThrow(MangoInjectionError);
    expect(() =>
      guarded.find({ selector: { sources: { $elemMatch: { id: 'x' } } } } as Nano.MangoQuery),
    ).toThrow(MangoInjectionError);
  });

  it('findTrusted() passes an operator selector straight through to the underlying find', async () => {
    const { scope, find } = makeScope();
    const guarded = withTypeGuard(scope, 'production');
    await expect(guarded.findTrusted(operatorQuery)).resolves.toEqual({ docs: [] });
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(operatorQuery);
  });
});
