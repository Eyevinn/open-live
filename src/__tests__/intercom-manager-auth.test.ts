/**
 * intercom-manager auth modes (issue #598, `docs/specs/guest-talkback.md` OQ3).
 *
 * - `direct` (default): `INTERCOM_MANAGER_TOKEN` is the Bearer as-is.
 * - `osc`: the token is an OSC PAT exchanged for a Service Access Token scoped
 *   to `eyevinn-intercom-manager` (the strom-token.ts exchange, generalised to
 *   take a serviceId), and the SAT is sent as the Bearer on management calls.
 *
 * Config is read at import time, so each test sets env and re-imports a clean
 * module graph (`vi.resetModules()`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TOKEN_URL = 'https://token.svc.prod.osaas.io/servicetoken';
const MANAGER = 'https://intercom.example.com/api/v1';

function mockFetch(calls: Array<{ url: string; auth?: string; pat?: string; body?: unknown }>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    const headers = new Headers(init?.headers as HeadersInit);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      url: u,
      auth: headers.get('authorization') ?? undefined,
      pat: headers.get('x-pat-jwt') ?? undefined,
      body,
    });
    if (u === TOKEN_URL) {
      return new Response(
        JSON.stringify({ token: `sat-for-${body.serviceId}`, expiry: Math.floor(Date.now() / 1000) + 3600 }),
        { status: 200 },
      );
    }
    if (u === `${MANAGER}/production/7/line`) {
      return new Response(JSON.stringify([{ name: 'guest-video_in_0', id: '3', smbConferenceId: 'c', participants: [] }]), {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

describe('intercom-manager auth mode', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env['INTERCOM_MANAGER_URL'] = MANAGER;
    process.env['INTERCOM_MANAGER_TOKEN'] = 'pat-or-key';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['INTERCOM_MANAGER_AUTH_MODE'];
    delete process.env['STROM_AUTH_MODE'];
    delete process.env['INTERCOM_WHIP_AUTH_KEY'];
  });

  it('direct (default): sends INTERCOM_MANAGER_TOKEN as the Bearer, no token exchange', async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    mockFetch(calls);
    const { provisionGuestLine } = await import('../lib/intercom-manager.js');

    const line = await provisionGuestLine({ intercomProductionId: '7', productionId: 'p', lineName: 'guest-video_in_0' });

    expect(line.id).toBe('3');
    expect(calls.map((c) => c.url)).toEqual([`${MANAGER}/production/7/line`]);
    expect(calls[0].auth).toBe('Bearer pat-or-key');
  });

  it('osc: exchanges the PAT for an eyevinn-intercom-manager SAT and sends the SAT', async () => {
    process.env['INTERCOM_MANAGER_AUTH_MODE'] = 'osc';
    const calls: Array<{ url: string; auth?: string; pat?: string; body?: unknown }> = [];
    mockFetch(calls);
    const { provisionGuestLine } = await import('../lib/intercom-manager.js');

    await provisionGuestLine({ intercomProductionId: '7', productionId: 'p', lineName: 'guest-video_in_0' });
    await provisionGuestLine({ intercomProductionId: '7', productionId: 'p', lineName: 'guest-video_in_0' });

    const exchanges = calls.filter((c) => c.url === TOKEN_URL);
    // The SAT is cached: one exchange for two provisions.
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].pat).toBe('Bearer pat-or-key');
    expect(exchanges[0].body).toEqual({ serviceId: 'eyevinn-intercom-manager' });
    const managerCalls = calls.filter((c) => c.url.startsWith(MANAGER));
    expect(managerCalls.every((c) => c.auth === 'Bearer sat-for-eyevinn-intercom-manager')).toBe(true);
  });

  it('osc: a failed SAT exchange surfaces as IntercomManagerError (join degrades)', async () => {
    process.env['INTERCOM_MANAGER_AUTH_MODE'] = 'osc';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('denied', { status: 401 }));
    const { provisionGuestLine, IntercomManagerError } = await import('../lib/intercom-manager.js');

    await expect(
      provisionGuestLine({ intercomProductionId: '7', productionId: 'p', lineName: 'guest-video_in_0' }),
    ).rejects.toBeInstanceOf(IntercomManagerError);
  });

  it('keeps separate SAT caches per OSC service (Strom vs intercom-manager)', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    mockFetch(calls);
    const { getStromToken, getOscServiceToken } = await import('../lib/strom-token.js');

    expect(await getStromToken('pat')).toBe('sat-for-eyevinn-strom');
    expect(await getOscServiceToken('pat', 'eyevinn-intercom-manager')).toBe('sat-for-eyevinn-intercom-manager');
    expect(await getStromToken('pat')).toBe('sat-for-eyevinn-strom');

    expect(calls.filter((c) => c.url === TOKEN_URL).map((c) => c.body)).toEqual([
      { serviceId: 'eyevinn-strom' },
      { serviceId: 'eyevinn-intercom-manager' },
    ]);
  });

  // Talkback WHIP/WHEP proxy auth (issue #599, guest-talkback spec §7 / OQ3).
  it('talkback, direct: sends INTERCOM_WHIP_AUTH_KEY, not the management token', async () => {
    process.env['INTERCOM_WHIP_AUTH_KEY'] = 'whip-key';
    const { talkbackAuthorization } = await import('../lib/intercom-manager.js');
    expect(await talkbackAuthorization()).toBe('Bearer whip-key');
  });

  it('talkback, direct with INTERCOM_WHIP_AUTH_KEY unset: no Authorization', async () => {
    const { talkbackAuthorization } = await import('../lib/intercom-manager.js');
    expect(await talkbackAuthorization()).toBeUndefined();
  });

  it('talkback, osc: sends the eyevinn-intercom-manager SAT (and ignores INTERCOM_WHIP_AUTH_KEY)', async () => {
    process.env['INTERCOM_MANAGER_AUTH_MODE'] = 'osc';
    process.env['INTERCOM_WHIP_AUTH_KEY'] = 'whip-key';
    const calls: Array<{ url: string; body?: unknown }> = [];
    mockFetch(calls);
    const { talkbackAuthorization } = await import('../lib/intercom-manager.js');
    expect(await talkbackAuthorization()).toBe('Bearer sat-for-eyevinn-intercom-manager');
    expect(calls.map((c) => c.body)).toEqual([{ serviceId: 'eyevinn-intercom-manager' }]);
  });
});
