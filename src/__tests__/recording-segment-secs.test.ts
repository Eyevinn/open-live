/**
 * Time-based recording parts (issue #553, OL-31b).
 *
 * `RECORDING_SEGMENT_SECS` sets Strom's recorder `max_size_time_secs`, so a
 * session is cut into consecutive parts. Default 600; `0` leaves the property
 * unset (one file per activation). Config is read at import, so each case
 * resets the module graph and re-imports flow-generator with the env set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const NAME = 'RECORDING_SEGMENT_SECS';

function makeStromClient() {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: {
      list: vi.fn().mockResolvedValue({ blocks: [{ id: 'builtin.recorder' }, { id: 'builtin.audioenc' }] }),
    },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-test-553' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

const production = {
  _id: 'prod-seg-1',
  _rev: '1-abc',
  type: 'production',
  name: 'Segmented Production',
  status: 'inactive',
  sources: [{ sourceId: '__test1__', mixerInput: 'video_in_1' }],
  graphicAssignments: [],
  values: {},
  pipeline: { stromConfig: null, status: 'stopped' },
  graphics: [],
  macros: [],
  tally: { pgm: null, pvw: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const recordingOutput = {
  _id: 'output-rec-seg12345',
  type: 'output' as const,
  outputType: 'recording' as const,
  name: 'VOD Recording',
  createdAt: '',
  updatedAt: '',
};

async function recorderProperties(): Promise<Record<string, unknown>> {
  vi.resetModules();
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const strom = makeStromClient();
  await activateStromFlow(production as never, strom as never, 'http://localhost:7000', [
    recordingOutput,
  ] as never);
  const blocks = strom.capturedFlows[0]!['blocks'] as Array<Record<string, unknown>>;
  const recorder = blocks.find((b) => b['block_definition_id'] === 'builtin.recorder');
  expect(recorder).toBeDefined();
  return recorder!['properties'] as Record<string, unknown>;
}

async function loadConfig() {
  vi.resetModules();
  return (await import('../config.js')).config;
}

describe('recorder max_size_time_secs from RECORDING_SEGMENT_SECS (#553)', () => {
  beforeEach(() => delete process.env[NAME]);
  afterEach(() => delete process.env[NAME]);

  it('cuts 600-second parts by default', async () => {
    const props = await recorderProperties();
    expect(props['max_size_time_secs']).toBe(600);
    expect(props['output_dir']).toBe('recordings/prod-seg-1');
    expect(props['filename_prefix']).toBe('prod-seg-1');
  });

  it('uses the configured part length', async () => {
    process.env[NAME] = '60';
    expect((await recorderProperties())['max_size_time_secs']).toBe(60);
  });

  it('leaves the property unset when the value is 0', async () => {
    process.env[NAME] = '0';
    expect(await recorderProperties()).not.toHaveProperty('max_size_time_secs');
  });
});

describe('config.recordingSegmentSecs (#553)', () => {
  beforeEach(() => delete process.env[NAME]);
  afterEach(() => delete process.env[NAME]);

  it('defaults to 600 when unset or empty', async () => {
    expect((await loadConfig()).recordingSegmentSecs).toBe(600);
    process.env[NAME] = '';
    expect((await loadConfig()).recordingSegmentSecs).toBe(600);
  });

  it('accepts 0 and the 24-hour maximum', async () => {
    process.env[NAME] = '0';
    expect((await loadConfig()).recordingSegmentSecs).toBe(0);
    process.env[NAME] = '86400';
    expect((await loadConfig()).recordingSegmentSecs).toBe(86400);
  });

  it.each(['-1', '1.5', 'ten', '86401'])('refuses %s at startup', async (raw) => {
    process.env[NAME] = raw;
    await expect(loadConfig()).rejects.toThrow(`${NAME} must be a non-negative integer up to 86400`);
  });
});
