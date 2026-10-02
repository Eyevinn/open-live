/**
 * The per-activation recording sidecar (services/recording-index.ts): maps
 * inputs to sources and guests, and times each recorder file from Strom's
 * RecorderFileChanged events.
 *
 * Strom's WebSocket and media API, and CouchDB, are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sessions: Array<Record<string, unknown>> = [];
vi.mock('../db/index.js', () => ({
  getGuestSessionsDb: () => ({ find: vi.fn(async () => ({ docs: sessions })) }),
  getGuestInvitesDb: () => ({
    get: vi.fn(async (id: string) => {
      if (id === 'invite-anna') return { _id: id, label: 'Anna (commentary)' };
      throw new Error('missing');
    }),
  }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

let emit: (event: unknown) => void;
const uploads: Array<{ dir: string; name: string; body: Record<string, unknown> }> = [];
const mockCloseWs = vi.fn();
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    connectWebSocket(onEvent: (e: unknown) => void, _onClose?: () => void, onOpen?: () => void) {
      emit = onEvent;
      queueMicrotask(() => onOpen?.());
      return mockCloseWs;
    }
    media = {
      upload: vi.fn(async (dir: string, name: string, body: string) => {
        uploads.push({ dir, name, body: JSON.parse(body) });
      }),
    };
  }
  return { ...actual, StromClient: MockStromClient };
});

import { bindRecordingIndex, closeRecordingIndex, openRecordingIndex, type RecordingIndexHandle } from '../services/recording-index.js';

const DIR = 'recordings/prod-1/20261001T100000Z-11111111-1111-4111-8111-111111111111';
const ACTIVATED = Date.parse('2026-10-01T10:00:00.000Z');

function bind(handle: RecordingIndexHandle) {
  bindRecordingIndex(handle, {
    productionId: 'prod-1',
    productionName: 'Meeting',
    flowId: 'flow-1',
    dir: DIR,
    activatedAtMs: ACTIVATED,
    program: { recorderBlockId: 'b-rec', outputDir: DIR },
    inputs: [{
      mixerInput: 'video_in_1',
      blockIds: { video: 'b-inrec-v-1', audio: 'b-inrec-a-1' },
      outputDir: `${DIR}/video_in_1`,
      sourceId: 'Whip',
      sourceName: 'WHIP Input',
      streamType: 'whip',
      recordMode: 'transcode',
    }],
  });
}

const fileEvent = (block_id: string, filename: string, flow_id = 'flow-1') =>
  ({ type: 'RecorderFileChanged', data: { flow_id, block_id, filename } });

const last = () => uploads[uploads.length - 1]!;

beforeEach(() => {
  vi.clearAllMocks();
  uploads.length = 0;
  sessions.length = 0;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ACTIVATED);
});

afterEach(async () => {
  await closeRecordingIndex('prod-1');
  vi.useRealTimers();
});

describe('recording index', () => {
  it('writes the sidecar into the activation directory on bind', async () => {
    const handle = await openRecordingIndex('prod-1');
    bind(handle);
    await closeRecordingIndex('prod-1');
    expect(last().dir).toBe(DIR);
    expect(last().name).toBe('recordings.json');
    expect(last().body).toMatchObject({
      version: 1,
      productionId: 'prod-1',
      flowId: 'flow-1',
      activatedAtMs: ACTIVATED,
      program: { recorderBlockId: 'b-rec', startedAtMs: null, files: [] },
      inputs: {
        video_in_1: {
          sourceId: 'Whip', sourceName: 'WHIP Input', recordMode: 'transcode',
          tracks: {
            video: { recorderBlockId: 'b-inrec-v-1', startedAtMs: null, files: [] },
            audio: { recorderBlockId: 'b-inrec-a-1', startedAtMs: null, files: [] },
          },
        },
      },
    });
  });

  it('times each file from its RecorderFileChanged, including events before bind', async () => {
    const handle = await openRecordingIndex('prod-1');
    vi.setSystemTime(ACTIVATED + 500);
    emit(fileEvent('b-rec', `${DIR}/prod-1_00000.mp4`));
    bind(handle);
    vi.setSystemTime(ACTIVATED + 90_000);
    emit(fileEvent('b-inrec-a-1', `${DIR}/video_in_1/prod-1_video_in_1_audio_00000.mp4`));
    vi.setSystemTime(ACTIVATED + 92_000);
    emit(fileEvent('b-inrec-v-1', `${DIR}/video_in_1/prod-1_video_in_1_video_00000.mp4`));
    vi.setSystemTime(ACTIVATED + 95_000);
    emit(fileEvent('b-inrec-v-1', `${DIR}/video_in_1/prod-1_video_in_1_video_00001.mp4`));
    await closeRecordingIndex('prod-1');

    const { program, inputs } = last().body as { program: Record<string, unknown>; inputs: Record<string, Record<string, unknown>> };
    expect(program).toMatchObject({ startedAtMs: ACTIVATED + 500, files: [{ path: `${DIR}/prod-1_00000.mp4`, openedAtMs: ACTIVATED + 500 }] });
    expect(inputs['video_in_1']!['tracks']).toMatchObject({
      audio: { startedAtMs: ACTIVATED + 90_000, files: [{ path: `${DIR}/video_in_1/prod-1_video_in_1_audio_00000.mp4`, openedAtMs: ACTIVATED + 90_000 }] },
      video: {
        startedAtMs: ACTIVATED + 92_000,
        files: [
          { path: `${DIR}/video_in_1/prod-1_video_in_1_video_00000.mp4`, openedAtMs: ACTIVATED + 92_000 },
          { path: `${DIR}/video_in_1/prod-1_video_in_1_video_00001.mp4`, openedAtMs: ACTIVATED + 95_000 },
        ],
      },
    });
  });

  it("uses Strom's pipeline-clock start when the event carries one", async () => {
    const handle = await openRecordingIndex('prod-1');
    bind(handle);
    vi.setSystemTime(ACTIVATED + 90_000);
    emit({
      type: 'RecorderFileChanged',
      data: {
        flow_id: 'flow-1', block_id: 'b-inrec-v-1', filename: `${DIR}/video_in_1/v_00000.mp4`,
        start_running_time_ns: 89_500_000_000, start_utc_us: (ACTIVATED + 89_640) * 1000 + 250,
      },
    });
    emit(fileEvent('b-inrec-a-1', `${DIR}/video_in_1/a_00000.mp4`));
    await closeRecordingIndex('prod-1');

    const tracks = (last().body['inputs'] as Record<string, { tracks: Record<string, unknown> }>)['video_in_1']!.tracks;
    expect(tracks['video']).toEqual(expect.objectContaining({
      startedAtMs: ACTIVATED + 89_640.25,
      files: [{ path: `${DIR}/video_in_1/v_00000.mp4`, openedAtMs: ACTIVATED + 90_000, startMs: ACTIVATED + 89_640.25 }],
    }));
    expect(tracks['audio']).toEqual(expect.objectContaining({
      startedAtMs: ACTIVATED + 90_000,
      files: [{ path: `${DIR}/video_in_1/a_00000.mp4`, openedAtMs: ACTIVATED + 90_000 }],
    }));
  });

  it("ignores other flows' recorders", async () => {
    const handle = await openRecordingIndex('prod-1');
    emit(fileEvent('b-rec', 'recordings/other/x.mp4', 'flow-other'));
    bind(handle);
    emit(fileEvent('b-rec', 'recordings/other/y.mp4', 'flow-other'));
    await closeRecordingIndex('prod-1');
    expect((last().body['program'] as { files: unknown[] }).files).toEqual([]);
  });

  it('lists the guests on a recorded input during the activation, with their invite labels', async () => {
    sessions.push(
      { inviteId: 'invite-old', mixerInput: 'video_in_1', state: 'left', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T09:00:00.000Z' },
      { inviteId: 'invite-anna', mixerInput: 'video_in_1', state: 'left', createdAt: '2026-10-01T10:01:00.000Z', updatedAt: '2026-10-01T10:20:00.000Z' },
      { inviteId: 'invite-bo', mixerInput: 'video_in_1', state: 'joined', createdAt: '2026-10-01T10:21:00.000Z', updatedAt: '2026-10-01T10:21:00.000Z' },
      { inviteId: 'invite-cy', mixerInput: 'video_in_3', state: 'joined', createdAt: '2026-10-01T10:05:00.000Z', updatedAt: '2026-10-01T10:05:00.000Z' },
    );
    const handle = await openRecordingIndex('prod-1');
    bind(handle);
    await closeRecordingIndex('prod-1');
    expect((last().body['inputs'] as Record<string, { guests: unknown[] }>)['video_in_1']!.guests).toEqual([
      { inviteId: 'invite-anna', label: 'Anna (commentary)', joinedAt: '2026-10-01T10:01:00.000Z', leftAt: '2026-10-01T10:20:00.000Z' },
      { inviteId: 'invite-bo', joinedAt: '2026-10-01T10:21:00.000Z' },
    ]);
  });

  it('closes itself when its flow is deleted', async () => {
    const handle = await openRecordingIndex('prod-1');
    bind(handle);
    emit({ type: 'FlowDeleted', data: { flow_id: 'flow-1' } });
    await vi.waitFor(() => expect(mockCloseWs).toHaveBeenCalledOnce());
  });

  it('closing a stale handle leaves the newer activation\'s index open', async () => {
    const stale = await openRecordingIndex('prod-1');
    const current = await openRecordingIndex('prod-1');
    expect(mockCloseWs).toHaveBeenCalledOnce();
    await closeRecordingIndex(stale);
    expect(mockCloseWs).toHaveBeenCalledOnce();
    bind(current);
    await closeRecordingIndex('prod-1');
    expect(mockCloseWs).toHaveBeenCalledTimes(2);
    expect(last().dir).toBe(DIR);
  });

  it('does nothing when closed without being opened', async () => {
    await closeRecordingIndex('prod-unknown');
    expect(uploads).toEqual([]);
  });
});
