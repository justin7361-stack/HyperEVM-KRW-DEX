import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WalletRateLimiter } from '../../src/core/matching/WalletRateLimiter.js'

const ADDR_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ADDR_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

describe('WalletRateLimiter', () => {
  let limiter: WalletRateLimiter

  beforeEach(() => {
    vi.useFakeTimers()
    limiter = new WalletRateLimiter({ maxRequests: 3, windowMs: 1000 })
  })

  afterEach(() => {
    limiter.destroy()
    vi.useRealTimers()
  })

  it('allows first N requests', () => {
    expect(limiter.isAllowed(ADDR_A)).toBe(true)
    expect(limiter.isAllowed(ADDR_A)).toBe(true)
    expect(limiter.isAllowed(ADDR_A)).toBe(true)
  })

  it('rejects N+1 request within the window', () => {
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    expect(limiter.isAllowed(ADDR_A)).toBe(false)
  })

  it('allows requests again after windowMs passes', () => {
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    // N+1 is rejected
    expect(limiter.isAllowed(ADDR_A)).toBe(false)

    // Advance time past the window
    vi.advanceTimersByTime(1001)

    // Should be allowed again
    expect(limiter.isAllowed(ADDR_A)).toBe(true)
  })

  it('remaining() returns correct count before any requests', () => {
    expect(limiter.remaining(ADDR_A)).toBe(3)
  })

  it('remaining() decrements with each allowed request', () => {
    limiter.isAllowed(ADDR_A)
    expect(limiter.remaining(ADDR_A)).toBe(2)
    limiter.isAllowed(ADDR_A)
    expect(limiter.remaining(ADDR_A)).toBe(1)
    limiter.isAllowed(ADDR_A)
    expect(limiter.remaining(ADDR_A)).toBe(0)
  })

  it('remaining() returns 0 when over limit', () => {
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A) // N+1 — over limit
    expect(limiter.remaining(ADDR_A)).toBe(0)
  })

  it('different addresses do not interfere with each other', () => {
    // Fill up ADDR_A
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    expect(limiter.isAllowed(ADDR_A)).toBe(false)

    // ADDR_B should still be at full capacity
    expect(limiter.isAllowed(ADDR_B)).toBe(true)
    expect(limiter.isAllowed(ADDR_B)).toBe(true)
    expect(limiter.isAllowed(ADDR_B)).toBe(true)
    expect(limiter.isAllowed(ADDR_B)).toBe(false)
  })

  it('is case-insensitive for addresses', () => {
    const lower = ADDR_A.toLowerCase()
    const upper = ADDR_A.toUpperCase()

    limiter.isAllowed(lower)
    limiter.isAllowed(lower)
    limiter.isAllowed(lower)
    // Upper-case variant should share the same bucket and be rejected
    expect(limiter.isAllowed(upper)).toBe(false)
  })

  it('remaining() recovers after window elapses', () => {
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    limiter.isAllowed(ADDR_A)
    expect(limiter.remaining(ADDR_A)).toBe(0)

    vi.advanceTimersByTime(1001)
    expect(limiter.remaining(ADDR_A)).toBe(3)
  })
})
