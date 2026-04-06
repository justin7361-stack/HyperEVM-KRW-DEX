import { describe, it, expect, vi } from 'vitest'
import { CircuitBreaker } from '../../src/core/matching/CircuitBreaker.js'

const PAIR = 'ETH/KRW'

describe('CircuitBreaker', () => {
  describe('initial state', () => {
    it('isHalted returns false initially', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      expect(cb.isHalted(PAIR)).toBe(false)
    })

    it('getHaltedPairs returns empty array initially', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      expect(cb.getHaltedPairs()).toEqual([])
    })
  })

  describe('manual halt/resume', () => {
    it('halt() causes isHalted to return true', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      cb.halt(PAIR, 'test halt')
      expect(cb.isHalted(PAIR)).toBe(true)
    })

    it('halt() + resume() → isHalted returns false', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      cb.halt(PAIR, 'test halt')
      cb.resume(PAIR)
      expect(cb.isHalted(PAIR)).toBe(false)
    })

    it('halt() is idempotent — second halt is no-op', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('halted', listener)
      cb.halt(PAIR, 'first')
      cb.halt(PAIR, 'second')
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('resume() on non-halted pair is a no-op', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('resumed', listener)
      cb.resume(PAIR)
      expect(listener).not.toHaveBeenCalled()
      expect(cb.isHalted(PAIR)).toBe(false)
    })
  })

  describe('events', () => {
    it('emits halted event with correct shape', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('halted', listener)
      cb.halt(PAIR, 'manual test')
      expect(listener).toHaveBeenCalledOnce()
      const arg = listener.mock.calls[0][0]
      expect(arg).toMatchObject({ pairId: PAIR, reason: 'manual test' })
      expect(typeof arg.haltedAt).toBe('number')
    })

    it('emits resumed event with correct shape', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('resumed', listener)
      cb.halt(PAIR, 'test')
      cb.resume(PAIR)
      expect(listener).toHaveBeenCalledOnce()
      const arg = listener.mock.calls[0][0]
      expect(arg).toMatchObject({ pairId: PAIR })
      expect(typeof arg.resumedAt).toBe('number')
    })
  })

  describe('getHaltedPairs', () => {
    it('returns correct list after halting multiple pairs', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      cb.halt('BTC/KRW', 'reason A')
      cb.halt('ETH/KRW', 'reason B')
      const halted = cb.getHaltedPairs()
      expect(halted).toHaveLength(2)
      expect(halted.map(h => h.pairId)).toContain('BTC/KRW')
      expect(halted.map(h => h.pairId)).toContain('ETH/KRW')
    })

    it('removes pair from halted list after resume', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      cb.halt('BTC/KRW', 'test')
      cb.halt('ETH/KRW', 'test')
      cb.resume('BTC/KRW')
      const halted = cb.getHaltedPairs()
      expect(halted).toHaveLength(1)
      expect(halted[0].pairId).toBe('ETH/KRW')
    })
  })

  describe('recordPrice auto-trip', () => {
    it('does NOT trip when only one price recorded', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      cb.recordPrice(PAIR, 1000n)
      expect(cb.isHalted(PAIR)).toBe(false)
    })

    it('does NOT trip when price move is within band', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      // 5% move — within 10% band
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 1050n)
      expect(cb.isHalted(PAIR)).toBe(false)
    })

    it('auto-trips when price moves more than band', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      // 20% move — exceeds 10% band
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 1200n)
      expect(cb.isHalted(PAIR)).toBe(true)
    })

    it('auto-trips on downward price move exceeding band', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      // -15% move
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 850n)
      expect(cb.isHalted(PAIR)).toBe(true)
    })

    it('auto-trip reason includes pct move in message', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('halted', listener)
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 1200n)
      expect(listener).toHaveBeenCalledOnce()
      expect(listener.mock.calls[0][0].reason).toMatch(/auto:/)
      expect(listener.mock.calls[0][0].reason).toMatch(/20\.00%/)
    })

    it('does NOT trip when old entries fall outside window', () => {
      vi.useFakeTimers()
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })

      // Record initial price
      cb.recordPrice(PAIR, 1000n)

      // Advance past the window
      vi.advanceTimersByTime(61_000)

      // Now record a large move — but original entry is outside window
      cb.recordPrice(PAIR, 5000n)
      // Only one entry in the window, so no auto-trip
      expect(cb.isHalted(PAIR)).toBe(false)

      vi.useRealTimers()
    })

    it('records price but skips auto-trip check if already halted', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      const listener = vi.fn()
      cb.on('halted', listener)

      cb.halt(PAIR, 'manual')
      // Even with extreme price move, only one halted event fires
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 9999n)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('trips exactly at band boundary (> not >=)', () => {
      const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
      // Exactly 10% move — should NOT trip (> not >=)
      cb.recordPrice(PAIR, 1000n)
      cb.recordPrice(PAIR, 1100n)
      expect(cb.isHalted(PAIR)).toBe(false)
    })
  })
})
