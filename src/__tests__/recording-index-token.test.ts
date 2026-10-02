/**
 * The recording index across a Strom token refresh. In OSC mode
 * getStromToken returns a short-lived SAT that it refreshes, so the index
 * must take a current token for each sidecar write and each reconnect.
 *
 * Strom and CouchDB are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  getGuestSessionsDb: () => ({ find: vi.fn(async () => ({ docs: [] })) }),
  getGuestInvitesDb: () => ({ get: vi.fn(async () => { throw new Error('missing'); }) }),
}));

let currentToken = 'sat-1';
vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn(async () => currentToken),
}));

let emit: (event: unknown) => void;
let onCloseCb: (() => void) | undefined;
const wsTokens: Array<string | undefined> = [];
const uploadTokens: Array<string | undefined> = [];
vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    token: string | undefined;
    constructor(opts: { baseUrl: string; token?: string }) { this.token = opts.token; }
    connectWebSocket(onEvent: (e: unknown) => void, onClose?: () => void, onOpen?: () => void) {
      wsTokens.push(this.token);
      emit = onEvent;
      onCloseCb = onClose;
      queueMicrotask(() => onOpen?.());
      return () => {};
    }
    media = {
      upload: vi.fn(async () => {
        uploadTokens.push(this.token);
        if (this.token !== currentToken) throw new actual.StromClientError(401, 'token expired');
      }),
    };
  }
  return { ...actual, StromClient: MockStromClient };
});

import { bindRecordingIndex, closeRecordingIndex, openRecordingIndex } from '../services/recording-index.js';

const DIR = 'recordings/prod-1/20261001T100000Z-11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  currentToken = 'sat-1';
  wsTokens.length = 0;
  uploadTokens.length = 0;
});
afterEach(async () => {
  await closeRecordingIndex('prod-1');
  vi.useRealTimers();
});

describe('recording index across a Strom token refresh', () => {
  it('writes the sidecar with the current token after the SAT it opened with has been replaced', async () => {
    const handle = await openRecordingIndex('prod-1');
    bindRecordingIndex(handle, {
      productionId: 'prod-1', productionName: 'P', flowId: 'flow-1', dir: DIR, activatedAtMs: Date.now(),
      program: { recorderBlockId: 'b-rec', outputDir: DIR }, inputs: [],
    });
    await vi.waitFor(() => expect(uploadTokens.length).toBe(1));
    // Later in the show the SAT has been refreshed.
    currentToken = 'sat-2';
    emit({ type: 'RecorderFileChanged', data: { flow_id: 'flow-1', block_id: 'b-rec', filename: `${DIR}/a_00001.mp4` } });
    await vi.waitFor(() => expect(uploadTokens.length).toBe(2));
    expect(uploadTokens[1]).toBe('sat-2');
  });

  it('reconnects the event socket with the current token', async () => {
    vi.useFakeTimers();
    const p = openRecordingIndex('prod-1');
    await vi.advanceTimersByTimeAsync(0);
    await p;
    currentToken = 'sat-2';
    onCloseCb?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(wsTokens).toHaveLength(2);
    expect(wsTokens[1]).toBe('sat-2');
  });
});
