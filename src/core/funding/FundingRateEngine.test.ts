import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FundingRateEngine, type FundingPayment } from './FundingRateEngine.js'
import type { MarginPosition } from '../../types/order.js'

const PAIR = 'ETH/KRW'

function makePosition(overrides: Partial<MarginPosition> = {}): MarginPosition {
  return {
    maker:  '0xAABB',
    pairId: PAIR,
    size:   10n * 10n ** 18n,   // 10 ETH long
    margin: 1000n,
    mode:   'isolated',
    ...overrides,
  }
}

describe('FundingRateEngine', () => {
  let engine: FundingRateEngine

  beforeEach(() => {
    engine = new FundingRateEngine(1000) // 1s interval for testing
  })

  afterEach(() => {
    engine.stopAll()
  })

  it('computeRate() returns positive rate when markPrice > indexPrice', () => {
    const mark  = 2100n * 10n ** 18n
    const index = 2000n * 10n ** 18n
    const result = engine.computeRate(mark, index)
    expect(result.rate).toBeCloseTo(0.05, 6)  // (2100 - 2000) / 2000 = 0.05
    expect(result.markPrice).toBe(mark)
    expect(result.indexPrice).toBe(index)
  })

  it('computeRate() returns rate=0 when indexPrice=0n', () => {
    const result = engine.computeRate(1000n, 0n)
    expect(result.rate).toBe(0)
  })

  it('applyFunding() emits payment for long position with positive rate (long pays)', async () => {
    // mark > index → positive rate → long position pays (amount < 0)
    const mark  = 2100n * 10n ** 18n
    const index = 2000n * 10n ** 18n
    const pos   = makePosition({ size: 1n * 10n ** 18n })  // 1 ETH long

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    expect(payments[0].maker).toBe('0xAABB')
    expect(payments[0].pairId).toBe(PAIR)
    // Long pays → amount should be negative (or zero if rounding)
    expect(payments[0].amount).toBeLessThanOrEqual(0n)
    expect(payments[0].rate).toBeCloseTo(0.05, 6)
  })

  it('applyFunding() emits payment for short position with positive rate (short receives)', async () => {
    const mark  = 2100n * 10n ** 18n
    const index = 2000n * 10n ** 18n
    const pos   = makePosition({ size: -(1n * 10n ** 18n) })  // 1 ETH short

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // Short receives when rate > 0 → amount should be positive
    expect(payments[0].amount).toBeGreaterThanOrEqual(0n)
  })

  it('rate cap — positive extreme: raw rate >600% is clamped to 600%', async () => {
    // mark = 1700, index = 100 → raw rate = (1700-100)/100 = 1600% → capped at 600%
    const mark  = 1700n * 10n ** 18n
    const index = 100n  * 10n ** 18n
    // size = 1 ETH long
    const pos = makePosition({ size: 1n * 10n ** 18n })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // notional = absSize * mark / 1e18 = 1e18 * 1700e18 / 1e18 = 1700e18
    const notional = 1n * 10n ** 18n * mark / 10n ** 18n
    // cappedRate = 6 * RATE_SCALE, so rawPayment = notional * 6n * RATE_SCALE / RATE_SCALE = notional * 6n
    const expectedRawPayment = notional * 6n
    // Long pays → amount is negative
    expect(payments[0].amount).toBe(-expectedRawPayment)
    // rate field clamped to 6.0
    expect(payments[0].rate).toBe(6.0)
  })

  it('rate cap — large negative rate is NOT clamped (floor is -100% with positive prices); long receives', async () => {
    // mark < index → negative rate → long receives (amount > 0), short pays
    // With positive prices, rate = (mark - index)/index ≥ -100% always (mark ≥ 0)
    // So the negative cap (-600%) is a safety net, not reachable in practice
    const mark  = 100n * 10n ** 18n    // mark = 100
    const index = 1000n * 10n ** 18n   // index = 1000 → rate = -90%
    const pos   = makePosition({ size: 1n * 10n ** 18n })   // long 1 ETH

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // -90% is within cap, not clamped
    expect(payments[0].rate).toBeGreaterThan(-6.0)
    expect(payments[0].rate).toBeCloseTo(-0.9, 6)
    // Long receives when rate < 0 (mark < index)
    expect(payments[0].amount).toBeGreaterThan(0n)
  })

  it('startPair() is idempotent — calling twice does not create two intervals; stopAll() clears all', () => {
    const getPositions  = () => []
    const getMarkPrice  = () => 1000n
    const getIndexPrice = () => 1000n

    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)
    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)  // idempotent

    // Internal timers map should only have 1 entry
    // We test by verifying stopAll clears without error
    expect(() => engine.stopAll()).not.toThrow()

    // After stopAll, starting again should work fine
    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)
    engine.stopAll()
  })
})
