/**
 * lib/ice-servers.ts — the ICE lookup shared by GET /api/v1/ice-servers and
 * the guest join: its cache, stale-on-error, and the deadline the join passes
 * so a hung Strom or token exchange stays off the guest's path. Without a
 * deadline (the crew route) it waits, as it always has.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { iceServersMock, getStromTokenMock } = vi.hoisted(() => ({
  iceServersMock: vi.fn(),
  getStromTokenMock: vi.fn(),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  return {
    ...actual,
    StromClient: class {
      system = { iceServers: iceServersMock };
    },
  };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: getStromTokenMock,
}));

import { getIceServers, resetIceServersCache } from '../lib/ice-servers.js';
import { StromClientError } from '../lib/strom.js';

const LIST = [{ urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' }];

beforeEach(() => {
  resetIceServersCache();
  iceServersMock.mockReset();
  getStromTokenMock.mockReset().mockResolvedValue('token');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getIceServers', () => {
  it("returns Strom's list, with no deadline unless one is asked for", async () => {
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    await expect(getIceServers()).resolves.toEqual({ iceServers: LIST });
    expect(iceServersMock).toHaveBeenLastCalledWith(undefined);
  });

  it('asks Strom to answer within a deadline when given one', async () => {
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    await expect(getIceServers({ timeoutMs: 3000 })).resolves.toEqual({ iceServers: LIST });
    const [timeoutMs] = iceServersMock.mock.calls[0];
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(3000);
  });

  it('serves the cached list, with the error, when Strom fails', async () => {
    iceServersMock.mockResolvedValueOnce({ ice_servers: LIST });
    await getIceServers();
    iceServersMock.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    const result = await getIceServers();
    expect(result.iceServers).toEqual(LIST);
    expect(result.stale).toBeInstanceOf(StromClientError);
  });

  it('throws when Strom fails and nothing is cached', async () => {
    iceServersMock.mockRejectedValue(new StromClientError(0, 'Strom unreachable'));
    await expect(getIceServers()).rejects.toBeInstanceOf(StromClientError);
  });

  it('drops the cached list after 5 minutes, so expired TURN credentials are not served', async () => {
    vi.useFakeTimers();
    iceServersMock.mockResolvedValueOnce({ ice_servers: LIST });
    await getIceServers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    iceServersMock.mockRejectedValueOnce(new StromClientError(0, 'Strom unreachable'));
    await expect(getIceServers()).rejects.toBeInstanceOf(StromClientError);
  });

  it('stops waiting for a hung token exchange at the deadline, without asking Strom', async () => {
    vi.useFakeTimers();
    getStromTokenMock.mockReturnValue(new Promise(() => {}));
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    const lookup = getIceServers({ timeoutMs: 3000 });
    const settled = expect(lookup).rejects.toThrow('No Strom token within 3000 ms');
    await vi.advanceTimersByTimeAsync(3000);
    await settled;
    // A Strom that needs the token cannot answer without it.
    expect(iceServersMock).not.toHaveBeenCalled();
  });

  it('waits for a slow token exchange when there is no deadline', async () => {
    vi.useFakeTimers();
    let giveToken: (token: string) => void = () => {};
    getStromTokenMock.mockReturnValue(new Promise<string>((resolve) => { giveToken = resolve; }));
    iceServersMock.mockResolvedValue({ ice_servers: LIST });
    const lookup = getIceServers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(iceServersMock).not.toHaveBeenCalled();
    giveToken('token');
    await expect(lookup).resolves.toEqual({ iceServers: LIST });
  });
});
