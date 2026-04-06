import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CancelAfterManager } from './CancelAfterManager.js'

describe('CancelAfterManager', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const MAKER = '0xDeadBeef00000000000000000000000000000001'

  function makeManager(cancelFn?: (maker: string) => Promise<number>) {
    const fn = cancelFn ?? vi.fn().mockResolvedValue(3)
    const mgr = new CancelAfterManager(fn)
    return { mgr, fn }
  }

  // ── Validation ──────────────────────────────────────────────────────────

  it('rejects seconds below MIN_SECONDS', () => {
    const { mgr } = makeManager()
    const result = mgr.set(MAKER, 4)
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/>=\s*5/)
  })

  it('rejects non-integer seconds', () => {
    const { mgr } = makeManager()
    const result = mgr.set(MAKER, 5.5)
    expect(result).toHaveProperty('error')
  })

  it('rejects seconds above MAX_SECONDS', () => {
    const { mgr } = makeManager()
    const result = mgr.set(MAKER, 86_401)
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toMatch(/86400/)
  })

  it('accepts seconds = MIN_SECONDS (5)', () => {
    const { mgr } = makeManager()
    const result = mgr.set(MAKER, 5)
    expect(result).toHaveProperty('cancelAt')
  })

  // ── Scheduling ──────────────────────────────────────────────────────────

  it('set() returns cancelAt ≈ now + seconds*1000', () => {
    const { mgr } = makeManager()
    const before = Date.now()
    const result = mgr.set(MAKER, 60) as { cancelAt: number }
    expect(result.cancelAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(result.cancelAt).toBeLessThanOrEqual(before + 60_001)
  })

  it('getScheduledAt() returns the cancelAt timestamp while active', () => {
    const { mgr } = makeManager()
    expect(mgr.getScheduledAt(MAKER)).toBeNull()
    const result = mgr.set(MAKER, 30) as { cancelAt: number }
    expect(mgr.getScheduledAt(MAKER)).toBe(result.cancelAt)
  })

  it('fires cancelAllFn after the specified delay', async () => {
    const cancelFn = vi.fn().mockResolvedValue(2)
    const { mgr } = makeManager(cancelFn)

    mgr.set(MAKER, 10)
    expect(cancelFn).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(cancelFn).toHaveBeenCalledOnce()
    expect(cancelFn).toHaveBeenCalledWith(MAKER)
  })

  it('clears scheduledAt after switch fires', async () => {
    const { mgr } = makeManager()
    mgr.set(MAKER, 10)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mgr.getScheduledAt(MAKER)).toBeNull()
  })

  // ── Heartbeat (reset) ───────────────────────────────────────────────────

  it('calling set() again resets the timer (heartbeat)', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    mgr.set(MAKER, 10)
    // advance 9 s — switch should NOT have fired
    await vi.advanceTimersByTimeAsync(9_000)
    expect(cancelFn).not.toHaveBeenCalled()

    // heartbeat: reset to 10 s again
    mgr.set(MAKER, 10)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(cancelFn).not.toHaveBeenCalled()   // still 1 s left

    await vi.advanceTimersByTimeAsync(1_000)
    expect(cancelFn).toHaveBeenCalledOnce()   // fires now
  })

  it('only one timer active at a time per maker', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    mgr.set(MAKER, 10)
    mgr.set(MAKER, 10)
    mgr.set(MAKER, 10)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(cancelFn).toHaveBeenCalledOnce()   // NOT 3 times
  })

  // ── clear() ─────────────────────────────────────────────────────────────

  it('clear() cancels the pending timer; cancelFn is never called', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    mgr.set(MAKER, 10)
    const cleared = mgr.clear(MAKER)
    expect(cleared).toBe(true)
    expect(mgr.getScheduledAt(MAKER)).toBeNull()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(cancelFn).not.toHaveBeenCalled()
  })

  it('clear() returns false when no timer is active', () => {
    const { mgr } = makeManager()
    expect(mgr.clear(MAKER)).toBe(false)
  })

  // ── seconds = 0 (disable) ────────────────────────────────────────────────

  it('set(maker, 0) disables the switch and returns cancelAt=0', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    mgr.set(MAKER, 30)
    const result = mgr.set(MAKER, 0) as { cancelAt: number }
    expect(result.cancelAt).toBe(0)
    expect(mgr.getScheduledAt(MAKER)).toBeNull()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(cancelFn).not.toHaveBeenCalled()
  })

  // ── Case-insensitive maker address ───────────────────────────────────────

  it('treats maker address case-insensitively', () => {
    const { mgr } = makeManager()
    mgr.set(MAKER.toLowerCase(), 10)
    expect(mgr.getScheduledAt(MAKER.toUpperCase())).not.toBeNull()
    mgr.clear(MAKER.toUpperCase())
    expect(mgr.getScheduledAt(MAKER.toLowerCase())).toBeNull()
  })

  // ── Multiple makers ─────────────────────────────────────────────────────

  it('tracks multiple makers independently', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    const MAKER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const MAKER_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

    mgr.set(MAKER_A, 5)
    mgr.set(MAKER_B, 10)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(cancelFn).toHaveBeenCalledTimes(1)
    expect(cancelFn).toHaveBeenCalledWith(MAKER_A)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(cancelFn).toHaveBeenCalledTimes(2)
    expect(cancelFn).toHaveBeenCalledWith(MAKER_B)
  })

  // ── destroy() ───────────────────────────────────────────────────────────

  it('destroy() clears all timers — cancelFn never fires', async () => {
    const cancelFn = vi.fn().mockResolvedValue(0)
    const { mgr } = makeManager(cancelFn)

    mgr.set('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 10)
    mgr.set('0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 20)
    mgr.destroy()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(cancelFn).not.toHaveBeenCalled()
  })
})
