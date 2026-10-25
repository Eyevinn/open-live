/**
 * OL-32a: program recording through Strom's Live Recorder
 * (`builtin.liverecorder`), with a `builtin.recorder` fallback (spec
 * iso-input-recording.md §4.1, §4.2; ADR-011).
 *
 *  - Block choice: Live Recorder when the block list has it; `builtin.recorder`
 *    when it is absent, when the list cannot be read, or with
 *    `RECORDING_BLOCK=recorder`.
 *  - Live Recorder program block: properties, raw main_out on audio_in_0, no
 *    builtin.audioenc, no recording-no-audio warning.
 *  - `RECORDING_BLOCK` parsing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

const ALL_BLOCKS = ['builtin.recorder', 'builtin.audioenc', 'builtin.liverecorder'];

function makeStromClient(blockIds: string[] | Error = ALL_BLOCKS) {
  const capturedFlows: Record<string, unknown>[] = [];
  return {
    blocks: {
      list: blockIds instanceof Error
        ? vi.fn().mockRejectedValue(blockIds)
        : vi.fn().mockResolvedValue({ blocks: blockIds.map((id) => ({ id })) }),
    },
    flows: {
      create: vi.fn().mockImplementation((flow: Record<string, unknown>) => {
        capturedFlows.push(flow);
        return Promise.resolve({ flow: { id: 'flow-lr-1' } });
      }),
      start: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    capturedFlows,
  };
}

const production = {
  _id: 'prod-lr-1',
  _rev: '1-abc',
  type: 'production',
  name: 'Live Recorder Production',
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
  _id: 'output-rec-lr123456',
  type: 'output' as const,
  outputType: 'recording' as const,
  name: 'VOD Recording',
  createdAt: '',
  updatedAt: '',
};

type Flow = { blocks: Array<Record<string, unknown>>; links: Array<Record<string, unknown>> };

async function activate(strom: ReturnType<typeof makeStromClient>) {
  const { activateStromFlow } = await import('../lib/flow-generator.js');
  const result = await activateStromFlow(production as never, strom as never, 'http://localhost:7000', [recordingOutput] as never);
  return { result, flow: strom.capturedFlows[0] as unknown as Flow };
}

const ENV = ['RECORDING_BLOCK', 'RECORDING_SEGMENT_SECS'];
beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  for (const n of ENV) delete process.env[n];
});
afterEach(() => {
  for (const n of ENV) delete process.env[n];
});

describe('chooseRecorderType (spec §4.1)', () => {
  it('picks Live Recorder when the block list has it, else builtin.recorder', async () => {
    const { chooseRecorderType } = await import('../lib/flow-generator.js');
    expect(chooseRecorderType(new Set(ALL_BLOCKS), 'auto')).toBe('liverecorder');
    expect(chooseRecorderType(new Set(['builtin.recorder', 'builtin.audioenc']), 'auto')).toBe('recorder');
  });

  it('falls back to builtin.recorder when the block list could not be read', async () => {
    const { chooseRecorderType } = await import('../lib/flow-generator.js');
    expect(chooseRecorderType(null, 'auto')).toBe('recorder');
  });

  it('always picks builtin.recorder with RECORDING_BLOCK=recorder', async () => {
    const { chooseRecorderType } = await import('../lib/flow-generator.js');
    expect(chooseRecorderType(new Set(ALL_BLOCKS), 'recorder')).toBe('recorder');
  });
});

describe('activateStromFlow — Live Recorder program block (spec §4.2)', () => {
  it('emits builtin.liverecorder fed by Enc PGM and raw main_out, with no audio encoder', async () => {
    const strom = makeStromClient();
    const { result, flow } = await activate(strom);

    expect(flow.blocks.find((b) => b['block_definition_id'] === 'builtin.recorder')).toBeUndefined();
    expect(flow.blocks.find((b) => b['block_definition_id'] === 'builtin.audioenc')).toBeUndefined();
    const rec = flow.blocks.find((b) => b['block_definition_id'] === 'builtin.liverecorder');
    expect(rec).toBeDefined();
    const recId = rec!['id'] as string;
    expect(recId).toMatch(/^b-out-/);
    expect(rec!['name']).toBe('VOD Recording');
    expect(rec!['properties']).toEqual({
      output_dir: 'recordings/prod-lr-1',
      filename_prefix: 'prod-lr-1',
      max_size_time_secs: 600,
      num_video_tracks: 1,
      num_audio_tracks: 1,
    });

    const videoIn = flow.links.find((l) => l['to'] === `${recId}:video_in_0`);
    const encPgm = flow.blocks.find((b) => b['name'] === 'Enc PGM');
    expect(String(videoIn?.['from'])).toMatch(new RegExp(`^${encPgm!['id'] as string}:`));
    const audioIn = flow.links.find((l) => l['to'] === `${recId}:audio_in_0`);
    expect(audioIn?.['from']).toMatch(/:main_out$/);

    expect(result).toMatchObject({
      recorderBlockId: recId,
      recorderType: 'liverecorder',
      recorderOutputId: recordingOutput._id,
      recorderOutputDir: 'recordings/prod-lr-1',
    });
    expect(result.warnings).toEqual([]);
    // The block list is read once per activation.
    expect(strom.blocks.list).toHaveBeenCalledTimes(1);
  });

  it('omits max_size_time_secs with RECORDING_SEGMENT_SECS=0', async () => {
    process.env['RECORDING_SEGMENT_SECS'] = '0';
    const { flow } = await activate(makeStromClient());
    const rec = flow.blocks.find((b) => b['block_definition_id'] === 'builtin.liverecorder');
    expect(rec!['properties']).not.toHaveProperty('max_size_time_secs');
  });
});

describe('activateStromFlow — builtin.recorder fallback is unchanged (AC 8)', () => {
  async function expectRecorderPath(strom: ReturnType<typeof makeStromClient>) {
    const { result, flow } = await activate(strom);
    expect(flow.blocks.find((b) => b['block_definition_id'] === 'builtin.liverecorder')).toBeUndefined();
    const rec = flow.blocks.find((b) => b['block_definition_id'] === 'builtin.recorder');
    expect(rec).toBeDefined();
    expect(rec!['properties']).toEqual({
      output_dir: 'recordings/prod-lr-1',
      filename_prefix: 'prod-lr-1',
      max_size_time_secs: 600,
    });
    const recId = rec!['id'] as string;
    expect(result.recorderBlockId).toBe(recId);
    expect(result.recorderType).toBe('recorder');
    // Audio still goes through builtin.audioenc (AAC), as before OL-32a.
    const audioIn = flow.links.find((l) => l['to'] === `${recId}:audio_in_0`);
    const [encId, pad] = (audioIn!['from'] as string).split(':');
    expect(pad).toBe('encoded_out');
    expect(flow.blocks.find((b) => b['id'] === encId)?.['block_definition_id']).toBe('builtin.audioenc');
    return result;
  }

  it('uses builtin.recorder when Strom has no builtin.liverecorder', async () => {
    const result = await expectRecorderPath(makeStromClient(['builtin.recorder', 'builtin.audioenc']));
    expect(result.warnings).toEqual([]);
  });

  it('uses builtin.recorder when the block list cannot be read', async () => {
    await expectRecorderPath(makeStromClient(new Error('Strom API error 503')));
  });

  it('uses builtin.recorder with RECORDING_BLOCK=recorder even when Live Recorder exists', async () => {
    process.env['RECORDING_BLOCK'] = 'recorder';
    await expectRecorderPath(makeStromClient());
  });

  it('keeps the recording-no-audio warning on a Strom without builtin.audioenc', async () => {
    const { result } = await activate(makeStromClient(['builtin.recorder']));
    expect(result.recorderType).toBe('recorder');
    expect(result.warnings).toEqual([expect.objectContaining({ type: 'recording-no-audio' })]);
  });
});

describe('config.recordingBlock (RECORDING_BLOCK)', () => {
  async function loadConfig() {
    vi.resetModules();
    return (await import('../config.js')).config;
  }

  it('defaults to auto when unset or empty', async () => {
    expect((await loadConfig()).recordingBlock).toBe('auto');
    process.env['RECORDING_BLOCK'] = ' ';
    expect((await loadConfig()).recordingBlock).toBe('auto');
  });

  it('accepts auto and recorder, case-insensitively', async () => {
    process.env['RECORDING_BLOCK'] = 'recorder';
    expect((await loadConfig()).recordingBlock).toBe('recorder');
    process.env['RECORDING_BLOCK'] = 'AUTO';
    expect((await loadConfig()).recordingBlock).toBe('auto');
  });

  it.each(['liverecorder', 'off', '1'])('refuses %s at startup', async (raw) => {
    process.env['RECORDING_BLOCK'] = raw;
    await expect(loadConfig()).rejects.toThrow(/RECORDING_BLOCK/);
  });
});
