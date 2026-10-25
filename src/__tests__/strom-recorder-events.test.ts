/**
 * Shared Strom recorder-event listener (issue #556): one socket for every
 * subscriber, RecorderFileChanged fan-out, reconnect with backoff and an
 * onConnected catch-up after each (re)connect, closed after the last
 * unsubscribe; the replay buffer and activation's hold (spec
 * iso-input-recording.md §6). The socket is a fake injected through the
 * factory hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subscribeRecorderEvents,
  setRecorderSocketFactory,
  resetRecorderEvents,
  recorderEventSubscriberCount,
  reconnectDelayMs,
  holdRecorderEvents,
  RECENT_EVENT_TTL_MS,
  type RecorderSocketHandlers,
} from '../services/strom-recorder-events.js';

interface FakeSocket {
  handlers: RecorderSocketHandlers;
  close: ReturnType<typeof vi.fn>;
}

let sockets: FakeSocket[];

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  setRecorderSocketFactory(async (handlers) => {
    const close = vi.fn();
    sockets.push({ handlers, close });
    return close;
  });
});

afterEach(() => {
  resetRecorderEvents();
  setRecorderSocketFactory(undefined);
  vi.useRealTimers();
});

const fileEvent = (filename: string) => ({
  type: 'RecorderFileChanged' as const,
  data: { flow_id: 'flow-1', block_id: 'rec-1', filename, start_utc_us: 1_790_000_000_000_000 },
});

describe('strom-recorder-events', () => {
  it('opens one socket for all subscribers and fans RecorderFileChanged out to each', async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeRecorderEvents({ onFileChanged: a });
    subscribeRecorderEvents({ onFileChanged: b });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    sockets[0]!.handlers.onOpen();
    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00001.mp4'));
    sockets[0]!.handlers.onEvent({ type: 'flow_started', flow_id: 'flow-1' });

    const expected = {
      flowId: 'flow-1',
      blockId: 'rec-1',
      filename: 'recordings/p/p_20261022_080000_00001.mp4',
      startUtcUs: 1_790_000_000_000_000,
      receivedAtMs: Date.now(),
    };
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(expected);
    expect(b).toHaveBeenCalledWith(expected);
  });

  it('ignores a malformed RecorderFileChanged frame', async () => {
    const a = vi.fn();
    subscribeRecorderEvents({ onFileChanged: a });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onEvent({ type: 'RecorderFileChanged', data: { flow_id: 'f' } } as never);
    expect(a).not.toHaveBeenCalled();
  });

  it('closes the socket after the last unsubscribe, and not before', async () => {
    const offA = subscribeRecorderEvents({ onFileChanged: vi.fn() });
    const offB = subscribeRecorderEvents({ onFileChanged: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    offA();
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    offB();
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    expect(recorderEventSubscriberCount()).toBe(0);
  });

  it('reconnects with backoff after a close and runs onConnected again', async () => {
    const onConnected = vi.fn();
    subscribeRecorderEvents({ onFileChanged: vi.fn(), onConnected });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onOpen();
    expect(onConnected).toHaveBeenCalledTimes(1);

    sockets[0]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0) - 1);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // The second attempt fails before opening: the delay doubles.
    sockets[1]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1) - 1);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);

    sockets[2]!.handlers.onOpen();
    expect(onConnected).toHaveBeenCalledTimes(2);
    // A stale socket's late events are dropped.
    const onFile = vi.fn();
    subscribeRecorderEvents({ onFileChanged: onFile });
    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00002.mp4'));
    expect(onFile).not.toHaveBeenCalled();
  });

  it('retries when opening the socket fails', async () => {
    let fail = true;
    setRecorderSocketFactory(async (handlers) => {
      if (fail) throw new Error('token exchange failed');
      const close = vi.fn();
      sockets.push({ handlers, close });
      return close;
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    subscribeRecorderEvents({ onFileChanged: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0));
    expect(sockets).toHaveLength(1);
  });

  it('stops reconnecting once nobody is subscribed', async () => {
    const off = subscribeRecorderEvents({ onFileChanged: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onClose();
    off();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('runs onConnected at once for a subscriber joining an open socket', async () => {
    subscribeRecorderEvents({ onFileChanged: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onOpen();
    const onConnected = vi.fn();
    subscribeRecorderEvents({ onFileChanged: vi.fn(), onConnected });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('replays a flow\'s buffered events to a new subscriber with their receipt time, before live ones', async () => {
    const hold = holdRecorderEvents();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onOpen();
    const receivedAt = Date.now();
    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00000.mp4'));
    sockets[0]!.handlers.onEvent({
      type: 'RecorderFileChanged',
      data: { flow_id: 'flow-other', block_id: 'rec-9', filename: 'recordings/q/q_20261022_080000_00000.mp4' },
    });
    await vi.advanceTimersByTimeAsync(4000);

    const seen: Array<{ filename: string; receivedAtMs: number }> = [];
    subscribeRecorderEvents({ onFileChanged: (e) => seen.push(e) }, { replayFlowId: 'flow-1' });
    expect(seen).toEqual([expect.objectContaining({ filename: 'recordings/p/p_20261022_080000_00000.mp4', receivedAtMs: receivedAt })]);
    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00001.mp4'));
    expect(seen.map((e) => e.filename)).toEqual([
      'recordings/p/p_20261022_080000_00000.mp4',
      'recordings/p/p_20261022_080000_00001.mp4',
    ]);
    expect(seen[1]!.receivedAtMs).toBe(receivedAt + 4000);
    // A subscriber that names no flow gets no replay.
    const plain = vi.fn();
    subscribeRecorderEvents({ onFileChanged: plain });
    expect(plain).not.toHaveBeenCalled();
    hold.release();
  });

  it('drops buffered events older than the TTL, and everything once the socket closes', async () => {
    const hold = holdRecorderEvents();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.handlers.onOpen();
    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00000.mp4'));
    await vi.advanceTimersByTimeAsync(RECENT_EVENT_TTL_MS + 1);
    const late = vi.fn();
    const off = subscribeRecorderEvents({ onFileChanged: late }, { replayFlowId: 'flow-1' });
    expect(late).not.toHaveBeenCalled();

    sockets[0]!.handlers.onEvent(fileEvent('recordings/p/p_20261022_080000_00001.mp4'));
    off();
    hold.release();
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1);
    const after = vi.fn();
    const hold2 = holdRecorderEvents();
    subscribeRecorderEvents({ onFileChanged: after }, { replayFlowId: 'flow-1' });
    expect(after).not.toHaveBeenCalled();
    hold2.release();
  });

  it('a hold opens the socket; ready resolves on open, on a failed attempt, or on timeout', async () => {
    const hold = holdRecorderEvents();
    expect(recorderEventSubscriberCount()).toBe(1);
    let ready = false;
    void hold.ready(2000).then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(ready).toBe(false);
    sockets[0]!.handlers.onOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
    // Already open: resolves at once.
    await hold.ready(2000);

    // A failed attempt resolves it too (activation then goes on without waiting).
    sockets[0]!.handlers.onClose();
    let failedReady = false;
    void hold.ready(2000).then(() => { failedReady = true; });
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(0));
    sockets[1]!.handlers.onClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(failedReady).toBe(true);

    // No outcome at all: the timeout resolves it.
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(1));
    let timedOut = false;
    void hold.ready(2000).then(() => { timedOut = true; });
    await vi.advanceTimersByTimeAsync(1999);
    expect(timedOut).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(timedOut).toBe(true);

    hold.release();
    hold.release();
    expect(recorderEventSubscriberCount()).toBe(0);
  });

  it('caps the backoff at 30 s', () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(10)).toBe(30_000);
  });
});
