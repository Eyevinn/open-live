/**
 * OL-32 recordings listing filters and order (spec iso-input-recording.md §2.4):
 * productionId / activationId / kind / mixerInput / sourceId, exact-match and
 * AND-ed, through the guarded find() with a plain-equality selector; 400 on an
 * invalid value; sorted by startedAt, program before inputs, mixerInput, part.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RecordingDoc } from '../db/types.js';

const TEST_BEARER = 'test-secret-key';
process.env['API_KEY'] = TEST_BEARER;
process.env['MINIO_ENDPOINT'] = 'https://minio.example.com';
process.env['MINIO_ACCESS_KEY'] = 'AKIAEXAMPLE';
process.env['MINIO_SECRET_KEY'] = 'secretexamplekey';
process.env['MINIO_BUCKET'] = 'openlive-vod';

const recordings: RecordingDoc[] = [];
const recordingsFind = vi.fn(async (query: { selector: Record<string, unknown> }) => ({
  docs: recordings.filter((r) =>
    Object.entries(query.selector).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v)),
}));

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: vi.fn(async (id: string) => ({ _id: id })), insert: vi.fn(), find: vi.fn(), findTrusted: vi.fn() }),
  getRecordingsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: recordingsFind }),
  getSourcesDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getOutputsDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  getGatewaysDb: () => ({ get: vi.fn(), insert: vi.fn(), find: vi.fn(), destroy: vi.fn() }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
}));

const AUTH = { authorization: `Bearer ${TEST_BEARER}` };
let app: FastifyInstance;

function rec(id: string, over: Partial<RecordingDoc>): RecordingDoc {
  return {
    _id: id, type: 'recording', productionId: 'prod-1', bucket: 'openlive-vod', key: `prod-1/${id}.mp4`,
    startedAt: '2026-11-01T18:00:00.000Z', createdAt: '', updatedAt: '', ...over,
  };
}

beforeAll(async () => {
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

beforeEach(() => {
  recordingsFind.mockClear();
  recordings.length = 0;
  recordings.push(
    rec('in10-0', { kind: 'input', mixerInput: 'video_in_10', sourceId: 'src-b', activationId: 'flow-1', partIndex: 0 }),
    rec('pgm-1', { kind: 'program', activationId: 'flow-1', partIndex: 1, startedAt: '2026-11-01T18:05:00.000Z' }),
    rec('in2-0', { kind: 'input', mixerInput: 'video_in_2', sourceId: 'src-a', activationId: 'flow-1', partIndex: 0 }),
    rec('legacy', { startedAt: '2026-10-01T10:00:00.000Z' }), // before `kind` existed
    rec('pgm-0', { kind: 'program', activationId: 'flow-1', partIndex: 0 }),
    rec('other', { kind: 'program', productionId: 'prod-2', activationId: 'flow-2', key: 'prod-2/x.mp4' }),
  );
});

async function list(url: string): Promise<{ status: number; ids: string[]; body: unknown }> {
  const res = await app.inject({ method: 'GET', url, headers: AUTH });
  const body = res.json();
  return { status: res.statusCode, ids: Array.isArray(body) ? body.map((r: { id: string }) => r.id) : [], body };
}

describe('GET /api/v1/recordings filters (spec §2.4)', () => {
  it('lists everything, sorted by startedAt, program before inputs, then pad number, then part', async () => {
    const { status, ids } = await list('/api/v1/recordings');
    expect(status).toBe(200);
    expect(ids).toEqual(['legacy', 'pgm-0', 'other', 'in2-0', 'in10-0', 'pgm-1']);
  });

  it('filters by production and activation with a plain equality selector', async () => {
    const { ids } = await list('/api/v1/recordings?productionId=prod-1&activationId=flow-1');
    expect(ids).toEqual(['pgm-0', 'in2-0', 'in10-0', 'pgm-1']);
    expect(recordingsFind).toHaveBeenLastCalledWith({
      selector: { type: 'recording', productionId: 'prod-1', activationId: 'flow-1' },
      limit: 500,
    });
  });

  it('filters by mixerInput and sourceId', async () => {
    expect((await list('/api/v1/recordings?mixerInput=video_in_2')).ids).toEqual(['in2-0']);
    expect((await list('/api/v1/recordings?sourceId=src-b')).ids).toEqual(['in10-0']);
  });

  it('kind=input matches input docs; kind=program includes docs without kind', async () => {
    expect((await list('/api/v1/recordings?kind=input')).ids).toEqual(['in2-0', 'in10-0']);
    expect((await list('/api/v1/recordings?kind=program&productionId=prod-1')).ids).toEqual(['legacy', 'pgm-0', 'pgm-1']);
  });

  it('lists docs without kind as program', async () => {
    const { body } = await list('/api/v1/recordings?productionId=prod-1');
    expect((body as Array<{ id: string; kind: string }>).find((r) => r.id === 'legacy')?.kind).toBe('program');
  });

  it('ignores unknown parameters', async () => {
    expect((await list('/api/v1/recordings?foo=bar')).ids).toHaveLength(6);
  });

  it.each([
    'kind=everything',
    'mixerInput=dsk_in_0',
    'mixerInput=video_in_123',
    `productionId=${'x'.repeat(129)}`,
    'activationId=',
  ])('400 on %s', async (q) => {
    const { status, body } = await list(`/api/v1/recordings?${q}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ statusCode: 400 });
  });

  it('never passes an operator through to the selector', async () => {
    // The flat querystring parser keeps `productionId[$gt]` as an unknown key: ignored.
    const { status } = await list('/api/v1/recordings?productionId[$gt]=');
    expect(status).toBe(200);
    expect(recordingsFind).toHaveBeenLastCalledWith({ selector: { type: 'recording' }, limit: 500 });
    // A repeated parameter is an array, not a string: refused.
    expect((await list('/api/v1/recordings?productionId=a&productionId=b')).status).toBe(400);
  });
});

describe('GET /api/v1/productions/:id/recordings filters', () => {
  it('fixes the production and applies the other filters', async () => {
    const { ids } = await list('/api/v1/productions/prod-1/recordings?kind=input&productionId=prod-2');
    expect(ids).toEqual(['in2-0', 'in10-0']);
    expect(recordingsFind).toHaveBeenLastCalledWith({
      selector: { type: 'recording', productionId: 'prod-1', kind: 'input' },
      limit: 500,
    });
  });

  it('400 on an invalid filter', async () => {
    expect((await list('/api/v1/productions/prod-1/recordings?mixerInput=x')).status).toBe(400);
  });
});
