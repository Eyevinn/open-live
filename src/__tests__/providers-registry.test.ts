/**
 * Tests for the source provider registry: reconciling provider candidates into
 * provider-owned SourceDocs. CouchDB is mocked; no services required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { providerSourceId, syncProvider, startSourceProviderSync } from '../providers/registry.js';
import type { ProviderSource, SourceProvider } from '../providers/types.js';
import { resetKeyCache } from '../lib/srt-passphrase-crypto.js';

const mockFind = vi.fn();
const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockIsDbConnected = vi.fn().mockReturnValue(true);

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ find: mockFind, get: mockGet, insert: mockInsert }),
  isDbConnected: () => mockIsDbConnected(),
}));

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function fakeProvider(list: () => Promise<ProviderSource[]>, id = 'fake'): SourceProvider {
  return { id, list };
}

const basic: ProviderSource = {
  externalId: 'basic/0',
  name: 'basic',
  streamType: 'srt',
  address: 'srt://172.27.0.10:20003?mode=caller',
  status: 'active',
};

function storedDoc(candidate: ProviderSource, overrides: Record<string, unknown> = {}) {
  return {
    _id: providerSourceId('fake', candidate.externalId),
    _rev: '1-abc',
    type: 'source',
    name: candidate.name,
    address: candidate.address,
    streamType: candidate.streamType,
    status: candidate.status ?? 'active',
    latency: candidate.latency,
    provider: { id: 'fake', externalId: candidate.externalId, syncedAt: '2026-09-01T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsDbConnected.mockReturnValue(true);
  mockFind.mockResolvedValue({ docs: [] });
  mockInsert.mockResolvedValue({ ok: true, id: 'x', rev: '2-def' });
});

describe('providerSourceId', () => {
  it('slugs the external id and prefixes it with the provider', () => {
    expect(providerSourceId('weave', 'basic/0')).toBe('src-ext-weave-basic-0');
    expect(providerSourceId('weave', 'Studio Cam #2')).toBe('src-ext-weave-studio-cam-2');
  });

  it('stays within the 128-character source id cap', () => {
    const id = providerSourceId('weave', 'x'.repeat(300));
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id.startsWith('src-ext-weave-')).toBe(true);
  });
});

describe('syncProvider', () => {
  it('creates a provider-owned doc for each new candidate', async () => {
    const second: ProviderSource = { ...basic, externalId: 'fanout/1', name: 'fanout (node-2)', address: 'srt://172.27.0.10:20004?mode=caller' };
    const result = await syncProvider(fakeProvider(async () => [basic, second]), log);

    expect(result).toMatchObject({ created: 2, updated: 0, deactivated: 0, skipped: [] });
    expect(mockInsert).toHaveBeenCalledTimes(2);
    const first = mockInsert.mock.calls[0][0];
    expect(first).toMatchObject({
      _id: 'src-ext-fake-basic-0',
      type: 'source',
      name: 'basic',
      address: basic.address,
      streamType: 'srt',
      status: 'active',
      provider: { id: 'fake', externalId: 'basic/0' },
    });
    expect(first._rev).toBeUndefined();
    expect(typeof first.provider.syncedAt).toBe('string');
    expect(first.createdAt).toBe(first.updatedAt);
    expect(mockInsert.mock.calls[1][0]._id).toBe('src-ext-fake-fanout-1');
    expect(mockFind).toHaveBeenCalledWith({ selector: { type: 'source', 'provider.id': 'fake' } });
  });

  it('defaults status to active when the candidate leaves it unset', async () => {
    const { status: _status, ...noStatus } = basic;
    await syncProvider(fakeProvider(async () => [noStatus]), log);
    expect(mockInsert.mock.calls[0][0].status).toBe('active');
  });

  it('writes nothing when the stored doc already matches', async () => {
    mockFind.mockResolvedValue({ docs: [storedDoc(basic)] });
    const result = await syncProvider(fakeProvider(async () => [basic]), log);

    expect(result).toMatchObject({ created: 0, updated: 0, deactivated: 0 });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('updates the existing doc in place when the address changes', async () => {
    const stored = storedDoc(basic);
    mockFind.mockResolvedValue({ docs: [stored] });
    const moved = { ...basic, address: 'srt://172.27.0.11:20005?mode=caller' };
    const result = await syncProvider(fakeProvider(async () => [moved]), log);

    expect(result).toMatchObject({ created: 0, updated: 1, deactivated: 0 });
    const written = mockInsert.mock.calls[0][0];
    expect(written._id).toBe(stored._id);
    expect(written._rev).toBe(stored._rev);
    expect(written.address).toBe(moved.address);
    expect(written.createdAt).toBe(stored.createdAt);
    expect(written.updatedAt).not.toBe(stored.updatedAt);
    expect(written.provider.syncedAt).not.toBe(stored.provider.syncedAt);
  });

  it('marks a provider-owned doc inactive when its candidate vanishes, but keeps it', async () => {
    const stored = storedDoc(basic);
    mockFind.mockResolvedValue({ docs: [stored] });
    const result = await syncProvider(fakeProvider(async () => []), log);

    expect(result).toMatchObject({ created: 0, updated: 0, deactivated: 1 });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const written = mockInsert.mock.calls[0][0];
    expect(written).toMatchObject({ _id: stored._id, _rev: stored._rev, status: 'inactive', name: 'basic' });
  });

  it('does not rewrite a doc that is already inactive', async () => {
    mockFind.mockResolvedValue({ docs: [storedDoc(basic, { status: 'inactive' })] });
    await syncProvider(fakeProvider(async () => []), log);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('reactivates a doc when its candidate is listed again', async () => {
    mockFind.mockResolvedValue({ docs: [storedDoc(basic, { status: 'inactive' })] });
    const result = await syncProvider(fakeProvider(async () => [basic]), log);
    expect(result.updated).toBe(1);
    expect(mockInsert.mock.calls[0][0].status).toBe('active');
  });

  it('leaves docs untouched and rethrows when the provider fails', async () => {
    mockFind.mockResolvedValue({ docs: [storedDoc(basic)] });
    await expect(
      syncProvider(fakeProvider(async () => { throw new Error('northbound unreachable'); }), log),
    ).rejects.toThrow('northbound unreachable');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('retries once on a 409 revision conflict using the re-read doc', async () => {
    const stored = storedDoc(basic);
    mockFind.mockResolvedValue({ docs: [stored] });
    const conflict = Object.assign(new Error('Document update conflict'), { statusCode: 409 });
    mockInsert.mockRejectedValueOnce(conflict);
    mockGet.mockResolvedValue({ ...stored, _rev: '5-newer' });
    const moved = { ...basic, name: 'basic renamed' };

    const result = await syncProvider(fakeProvider(async () => [moved]), log);

    expect(result.updated).toBe(1);
    expect(mockGet).toHaveBeenCalledWith(stored._id);
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsert.mock.calls[1][0]).toMatchObject({ _rev: '5-newer', name: 'basic renamed' });
  });

  it('skips candidates with an invalid SRT address or a duplicate externalId', async () => {
    const bad = { ...basic, externalId: 'bad/0', address: 'http://not-srt.example' };
    const result = await syncProvider(fakeProvider(async () => [basic, bad, basic]), log);

    expect(result.created).toBe(1);
    expect(result.skipped).toEqual([
      { externalId: 'bad/0', reason: 'Invalid SRT URL format — expected srt://host:port or srt://:port with safe query params' },
      { externalId: 'basic/0', reason: 'duplicate externalId' },
    ]);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  describe('with SRT_PASSPHRASE_KEY set', () => {
    beforeEach(() => {
      vi.stubEnv('SRT_PASSPHRASE_KEY', Buffer.alloc(32, 7).toString('base64'));
      resetKeyCache();
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      resetKeyCache();
    });

    it('stores the passphrase encrypted and compares against the decrypted form', async () => {
      const secret = { ...basic, address: 'srt://172.27.0.10:20003?passphrase=hunter22&mode=caller' };
      await syncProvider(fakeProvider(async () => [secret]), log);

      const stored = mockInsert.mock.calls[0][0];
      expect(stored.address).toMatch(/passphrase=encv1:/);
      expect(stored.address).not.toContain('hunter22');

      mockInsert.mockClear();
      mockFind.mockResolvedValue({ docs: [{ ...stored, _rev: '1-abc' }] });
      const result = await syncProvider(fakeProvider(async () => [secret]), log);
      expect(result).toMatchObject({ created: 0, updated: 0, deactivated: 0 });
      expect(mockInsert).not.toHaveBeenCalled();
    });
  });
});

describe('startSourceProviderSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function runTick() {
    await vi.advanceTimersByTimeAsync(1000);
  }

  it('logs a failing provider once, then once more on recovery', async () => {
    let fail = true;
    const provider = fakeProvider(async () => {
      if (fail) throw new Error('boom');
      return [basic];
    });
    const stop = startSourceProviderSync([provider], log, 1000);

    await runTick();
    await runTick();
    await runTick();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();

    fail = false;
    await runTick();
    expect(vi.mocked(log.info).mock.calls.some(([, msg]) => msg === '[providers] Sync recovered')).toBe(true);
    expect(mockInsert).toHaveBeenCalledTimes(1);

    stop();
    const insertsAfterStop = mockInsert.mock.calls.length;
    await runTick();
    await runTick();
    expect(mockInsert).toHaveBeenCalledTimes(insertsAfterStop);
  });

  it('skips the pass while the database is not connected', async () => {
    mockIsDbConnected.mockReturnValue(false);
    const list = vi.fn(async () => [basic]);
    const stop = startSourceProviderSync([fakeProvider(list)], log, 1000);
    await runTick();
    expect(list).not.toHaveBeenCalled();
    stop();
  });
});
