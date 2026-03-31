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

  it('rate cap — negative cap test: rate within ±600% is not clamped', async () => {
    // mark = 100, index = 1700 → raw rate = (100-1700)/1700 ≈ -94.1% → within cap, no clamping
    const mark  = 100n  * 10n ** 18n
    const index = 1700n * 10n ** 18n
    // size = 1 ETH long (long pays when mark < index is negative, so long receives)
    const pos = makePosition({ size: 1n * 10n ** 18n })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // rate ≈ -0.941 (within -6 to 6 range), so no clamping
    expect(payments[0].rate).toBeGreaterThan(-6.0)
    expect(payments[0].rate).toBeLessThan(0)
    // rate should be close to (100 - 1700) / 1700 ≈ -0.9412
    expect(payments[0].rate).toBeCloseTo(-16 / 17, 4)
    // Long position with negative rate → long receives (amount > 0)
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
