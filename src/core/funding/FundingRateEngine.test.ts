import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FundingRateEngine, type FundingPayment } from './FundingRateEngine.js'
import type { MarginPosition } from '../../types/order.js'

const PAIR = 'ETH/KRW'

function makePosition(overrides: Partial<MarginPosition> = {}): MarginPosition {
  return {
    maker:      '0xAABB',
    pairId:     PAIR,
    size:       10n * 10n ** 18n,   // 10 ETH long
    margin:     1000n,
    mode:       'isolated',
    entryPrice: 0n,
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

  // ── computeRate ─────────────────────────────────────────────────────────

  it('computeRate() returns positive rate when markPrice > indexPrice', () => {
    const mark  = 2100n * 10n ** 18n
    const index = 2000n * 10n ** 18n
    const result = engine.computeRate(mark, index)
    expect(result.rate).toBeCloseTo(0.05, 6)  // (2100 - 2000) / 2000 = 5%
    expect(result.markPrice).toBe(mark)
    expect(result.indexPrice).toBe(index)
  })

  it('computeRate() returns rate=0 when indexPrice=0n', () => {
    const result = engine.computeRate(1000n, 0n)
    expect(result.rate).toBe(0)
  })

  // ── applyFunding: direction ──────────────────────────────────────────────

  it('applyFunding() emits payment for long position with positive rate (long pays)', async () => {
    // mark > index → rate > 0 → long position pays (amount < 0)
    // rate = (10200 - 10000) / 10000 = 2% — within ±4% cap
    const mark  = 10200n * 10n ** 18n
    const index = 10000n * 10n ** 18n
    const pos   = makePosition({ size: 1n * 10n ** 18n })  // 1 ETH long

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    expect(payments[0].maker).toBe('0xAABB')
    expect(payments[0].pairId).toBe(PAIR)
    // Long pays → amount should be negative
    expect(payments[0].amount).toBeLessThan(0n)
    expect(payments[0].rate).toBeCloseTo(0.02, 6)   // 2%
  })

  it('applyFunding() emits payment for short position with positive rate (short receives)', async () => {
    // rate = 2% (within cap) → short receives (amount > 0)
    const mark  = 10200n * 10n ** 18n
    const index = 10000n * 10n ** 18n
    const pos   = makePosition({ size: -(1n * 10n ** 18n) })  // 1 ETH short

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    expect(payments[0].amount).toBeGreaterThan(0n)   // short receives
  })

  it('applyFunding() emits payment for long position with negative rate (long receives)', async () => {
    // mark < index → rate < 0 → long receives, short pays
    // rate = (9800 - 10000) / 10000 = -2% (within ±4% cap)
    const mark  = 9800n * 10n ** 18n
    const index = 10000n * 10n ** 18n
    const pos   = makePosition({ size: 1n * 10n ** 18n })  // 1 ETH long

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    expect(payments[0].amount).toBeGreaterThan(0n)   // long receives
    expect(payments[0].rate).toBeCloseTo(-0.02, 6)
  })

  it('skips position with size === 0n', async () => {
    const mark  = 10200n * 10n ** 18n
    const index = 10000n * 10n ** 18n
    const pos   = makePosition({ size: 0n })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(0)
  })

  it('skips position for a different pairId', async () => {
    const mark  = 10200n * 10n ** 18n
    const index = 10000n * 10n ** 18n
    const pos   = makePosition({ pairId: 'BTC/KRW' })  // different pair

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(0)
  })

  it('returns immediately when indexPrice === 0n', async () => {
    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(
      PAIR,
      () => [makePosition()],
      () => 1000n,
      () => 0n,          // zero index
    )

    expect(payments).toHaveLength(0)
  })

  // ── applyFunding: cap enforcement ±4% ────────────────────────────────────

  it('rate cap — positive extreme: raw rate +50% is clamped to +4%', async () => {
    // mark = 15000, index = 10000 → raw rate = (15000-10000)/10000 = 50% → capped at 4%
    const SCALE   = 10n ** 18n
    const mark    = 15000n * SCALE
    const index   = 10000n * SCALE
    const size    = 1n * SCALE            // 1 ETH long
    const pos     = makePosition({ size })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // notional = size * mark / 1e18 = 15000e18
    const notional = size * mark / SCALE
    // cappedRate = 4n * SCALE / 100n  ⟹  payment = notional * 4n / 100n
    const expectedPayment = notional * 4n / 100n
    // Long pays → amount is negative
    expect(payments[0].amount).toBe(-expectedPayment)
    // Human-readable rate capped at 0.04 (4%)
    expect(payments[0].rate).toBeCloseTo(0.04, 6)
  })

  it('rate cap — negative extreme: raw rate -90% is clamped to -4%', async () => {
    // mark = 1000, index = 10000 → raw rate = (1000-10000)/10000 = -90% → capped at -4%
    const SCALE = 10n ** 18n
    const mark  = 1000n * SCALE
    const index = 10000n * SCALE
    const size  = 1n * SCALE            // 1 ETH long
    const pos   = makePosition({ size })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    const notional = size * mark / SCALE     // notional = 1000e18
    // cappedRate = -4n * SCALE / 100n  ⟹  rawPayment = notional * (-4n) / 100n  (negative)
    // Long pos + negative rawPayment → amount = -rawPayment > 0 (long receives)
    const expectedAbs = notional * 4n / 100n
    expect(payments[0].amount).toBe(expectedAbs)    // positive: long receives
    expect(payments[0].rate).toBeCloseTo(-0.04, 6)  // capped at -4%
  })

  it('rate within cap — +3% is NOT clamped', async () => {
    // mark = 10300, index = 10000 → raw rate = 3% < 4% → not clamped
    const SCALE = 10n ** 18n
    const mark  = 10300n * SCALE
    const index = 10000n * SCALE
    const size  = 1n * SCALE
    const pos   = makePosition({ size })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    // raw rate = 3/100, payment = notional * 3n / 100n
    const notional = size * mark / SCALE
    const rateScaled = (mark - index) * SCALE / index   // = 3n * SCALE / 100n
    const expected = notional * rateScaled / SCALE
    expect(payments[0].amount).toBe(-expected)           // long pays
    expect(payments[0].rate).toBeCloseTo(0.03, 6)        // NOT clamped to 0.04
  })

  it('rate within cap — -2% is NOT clamped', async () => {
    const SCALE = 10n ** 18n
    const mark  = 9800n * SCALE
    const index = 10000n * SCALE
    const size  = 1n * SCALE
    const pos   = makePosition({ size })

    const payments: FundingPayment[] = []
    engine.on('payment', (p: FundingPayment) => payments.push(p))

    await engine.applyFunding(PAIR, () => [pos], () => mark, () => index)

    expect(payments).toHaveLength(1)
    expect(payments[0].rate).toBeCloseTo(-0.02, 6)      // NOT clamped to -0.04
    expect(payments[0].amount).toBeGreaterThan(0n)      // long receives
  })

  // ── startPair / stopPair ─────────────────────────────────────────────────

  it('startPair() is idempotent — calling twice does not create two intervals', () => {
    const getPositions  = () => []
    const getMarkPrice  = () => 10000n * 10n ** 18n
    const getIndexPrice = () => 10000n * 10n ** 18n

    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)
    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)  // idempotent

    expect(() => engine.stopAll()).not.toThrow()
  })

  it('stopAll() and restart works cleanly', () => {
    const getPositions  = () => []
    const getMarkPrice  = () => 10000n * 10n ** 18n
    const getIndexPrice = () => 10000n * 10n ** 18n

    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)
    engine.stopAll()

    // After stopAll, starting again should work fine
    engine.startPair(PAIR, getPositions, getMarkPrice, getIndexPrice)
    engine.stopAll()
  })

  it('stopPair() for unknown pairId does not throw', () => {
    expect(() => engine.stopPair('UNKNOWN/PAIR')).not.toThrow()
  })
})
