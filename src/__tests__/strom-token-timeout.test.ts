/**
 * Tests for getStromToken's bounded token exchange (issue #429).
 *
 * getStromToken exchanges the OSC PAT for a short-lived SAT with a `fetch`
 * that previously had no timeout. All callers share the in-flight exchange
 * (`inflightExchange`), so a token service that accepted the connection but
 * never answered left every Strom caller waiting forever, and the stale
 * in-flight promise was never cleared — so the hang didn't end when the
 * service recovered.
 *
 * The fix bounds the exchange with `AbortSignal.timeout(...)`. Here we stub
 * `AbortSignal.timeout` with a controllable signal so the "timeout" can be
 * fired deterministically (fake timers do NOT drive AbortSignal.timeout), and
 * assert that:
 *   - a never-resolving exchange rejects once its signal aborts, and
 *   - the shared in-flight promise is cleared so the NEXT call starts a fresh
 *     exchange instead of re-awaiting the dead one, and
 *   - a failed/timed-out refresh falls back to a cached SAT that is still valid.
 *
 * The module keeps process-wide cache + in-flight state, so each test resets
 * the module registry (`vi.resetModules()`) and re-imports a clean copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const realFetch = globalThis.fetch

/** A fetch mock that never settles on its own — it only rejects if its
 *  AbortSignal fires, mirroring a token service that accepts the connection
 *  but never answers. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () =>
          reject(signal.reason ?? new Error('aborted')),
        )
      }),
  )
}

/** Replace AbortSignal.timeout with controllable signals we can abort on
 *  demand, and record each one so the test can fire the "timeout". */
function stubTimeout() {
  const controllers: AbortController[] = []
  const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const c = new AbortController()
    controllers.push(c)
    return c.signal
  })
  const fireTimeout = (i: number) =>
    controllers[i]?.abort(new Error('The operation timed out'))
  return { spy, controllers, fireTimeout }
}

describe('getStromToken bounded exchange (#429)', () => {
  beforeEach(() => {
    vi.resetModules()
    delete process.env['STROM_AUTH_MODE']
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    vi.restoreAllMocks()
  })

  it('aborts a hung exchange and clears the in-flight promise so the next call retries', async () => {
    const { spy, fireTimeout } = stubTimeout()
    const fetchMock = hangingFetch()
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getStromToken } = await import('../lib/strom-token.js')

    const first = getStromToken('pat-123')
    // Let the exchange kick off (fetch invoked) before we fire the timeout.
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // The exchange is bounded by AbortSignal.timeout with a positive duration.
    expect(spy).toHaveBeenCalledWith(expect.any(Number))
    expect(spy.mock.calls[0]?.[0]).toBeGreaterThan(0)

    // Simulate the bounded timeout firing: the fetch rejects.
    fireTimeout(0)
    await expect(first).rejects.toThrow(/timed out/)

    // Critical: inflightExchange must have cleared. A second call must start a
    // BRAND NEW exchange rather than re-await the dead one.
    const second = getStromToken('pat-123')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireTimeout(1)
    await expect(second).rejects.toThrow(/timed out/)
  })

  it('falls back to a still-valid cached SAT when a refresh times out', async () => {
    const { fireTimeout } = stubTimeout()

    // First exchange succeeds, seeding the cache with a SAT that is expiring
    // soon (inside REFRESH_BUFFER_MS) but has NOT actually expired yet.
    const nearExpirySeconds = Math.floor((Date.now() + 2 * 60 * 1000) / 1000)
    const okResponse = {
      ok: true,
      json: async () => ({ token: 'cached-sat', expiry: nearExpirySeconds }),
    } as unknown as Response

    let call = 0
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      call += 1
      if (call === 1) return Promise.resolve(okResponse)
      // Second exchange hangs, then times out.
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () =>
          reject(signal.reason ?? new Error('aborted')),
        )
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const { getStromToken } = await import('../lib/strom-token.js')

    expect(await getStromToken('pat-123')).toBe('cached-sat')

    // Next call refreshes (SAT expiring soon); that refresh times out, but the
    // cached SAT is still valid, so the caller keeps serving it.
    const refreshing = getStromToken('pat-123')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fireTimeout(1)
    await expect(refreshing).resolves.toBe('cached-sat')
  })
})
