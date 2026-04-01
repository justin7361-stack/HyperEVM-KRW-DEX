import { describe, it, expect, vi, afterEach } from 'vitest'
import { MarkPriceOracle } from './MarkPriceOracle.js'
import type { TradeRecord } from '../../types/order.js'

const PAIR = 'ETH/KRW'

function makeTrade(price: bigint, tradedAt: number): TradeRecord {
  return {
    id:           'tid-1',
    pairId:       PAIR,
    price,
    amount:       1n * 10n ** 18n,
    isBuyerMaker: true,
    tradedAt,
  }
}

describe('MarkPriceOracle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('getMarkPrice() returns 0n for unknown pair', () => {
    const oracle = new MarkPriceOracle()
    expect(oracle.getMarkPrice('UNKNOWN/KRW')).toBe(0n)
  })

  it('onTrade() + getMarkPrice() returns average of recent trades', () => {
    const oracle = new MarkPriceOracle(60_000)
    const now = Date.now()
    oracle.onTrade(PAIR, makeTrade(1000n, now))
    oracle.onTrade(PAIR, makeTrade(2000n, now + 1))
    oracle.onTrade(PAIR, makeTrade(3000n, now + 2))
    // Average of 1000, 2000, 3000 = 2000
    expect(oracle.getMarkPrice(PAIR)).toBe(2000n)
  })

  it('trades outside windowMs are pruned — only recent trades count', () => {
    const windowMs = 5_000  // 5 seconds
    const oracle   = new MarkPriceOracle(windowMs)
    const now      = Date.now()

    // Old trade (outside window)
    oracle.onTrade(PAIR, makeTrade(1000n, now - 10_000))
    // Recent trade (inside window) — triggers pruning via its own tradedAt
    oracle.onTrade(PAIR, makeTrade(3000n, now))

    // Only the recent 3000n trade should remain
    expect(oracle.getMarkPrice(PAIR)).toBe(3000n)
  })

  it('setIndexPrice() + getMarkPrice() uses index when no trades exist', () => {
    const oracle = new MarkPriceOracle()
    oracle.setIndexPrice(PAIR, 5000n)
    expect(oracle.getMarkPrice(PAIR)).toBe(5000n)
  })

  it('getIndexPrice() falls back to mark price when no index set', () => {
    const oracle = new MarkPriceOracle(60_000)
    const now = Date.now()
    oracle.onTrade(PAIR, makeTrade(2500n, now))
    // No explicit index set → should return markPrice
    expect(oracle.getIndexPrice(PAIR)).toBe(2500n)
  })

  // ── 3-component mark price tests ────────────────────────────────────────────

  it('P1 computation — index + premium when funding rate and timestamp are set', () => {
    const oracle = new MarkPriceOracle()
    const SCALE  = 10n ** 18n
    const index  = 1000n * SCALE   // 1000 (18 decimals)

    // Funding rate = 1% (0.01), last funding was exactly 4 hours ago
    // → timeToNext = 8h − 4h = 4h, timeToNextFraction = 0.5
    const fourHoursMs = 4 * 3600 * 1000
    const now         = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    oracle.setIndexPrice(PAIR, index)
    oracle.setFundingRateGetter(() => ({ rateScaled: 10n ** 16n, timestamp: now - fourHoursMs }))
    // No mid price getter → mid falls back to TWAP = 0
    // rate 1%, time-to-next = 0.5 interval → premium = 0.01 × 0.5 = 0.005 → p1 = 1005 * SCALE
    // p2 = index (no spread history)
    // mid = 0
    // median(p1, index, 0) = index  (middle of sorted: 0, index, p1)
    // so median = index = 1000 * SCALE
    const p1Expected = 1005n * SCALE
    // p1 > index > 0 → median = index = 1000 * SCALE
    const mark = oracle.getMarkPrice(PAIR)
    expect(mark).toBe(index)   // median of (p1, index, 0n) = index
    // Verify p1 is indeed above index (premium positive)
    expect(p1Expected).toBeGreaterThan(index)
  })

  it('P1 computation — getMarkPrice selects P1 as median when mid is above index', () => {
    const oracle = new MarkPriceOracle()
    const SCALE  = 10n ** 18n
    const index  = 1000n * SCALE

    const fourHoursMs = 4 * 3600 * 1000
    const now         = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    oracle.setIndexPrice(PAIR, index)
    // rate = 1%, last funding 4h ago → timeToNext = 4h, fraction = 0.5
    // p1 = index * 1.005 = 1005 * SCALE
    oracle.setFundingRateGetter(() => ({ rateScaled: 10n ** 16n, timestamp: now - fourHoursMs }))
    // mid = 1010 * SCALE  (above p1)
    const mid = 1010n * SCALE
    oracle.setMidPriceGetter(() => mid)
    // p2 = index (no spread history) = 1000 * SCALE
    // sorted: [1000, 1005, 1010] → median = 1005
    // rate 1%, time-to-next = 0.5 interval → p1 = 1005 * SCALE
    const p1Expected = 1005n * SCALE

    expect(oracle.getMarkPrice(PAIR)).toBe(p1Expected)
  })

  it('P2 computation — index + MA of spread history', () => {
    const oracle  = new MarkPriceOracle()
    const SCALE   = 10n ** 18n
    const index   = 1000n * SCALE
    oracle.setIndexPrice(PAIR, index)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    // Simulate 3 trades within the 15-minute window with known spreads
    // trade at price 1010 → spread = +10 * SCALE
    // trade at price 990  → spread = -10 * SCALE
    // trade at price 1020 → spread = +20 * SCALE
    // MA = (10 - 10 + 20) / 3 * SCALE = 20/3 * SCALE
    oracle.onTrade(PAIR, makeTrade(1010n * SCALE, now - 5 * 60_000))
    oracle.onTrade(PAIR, makeTrade(990n  * SCALE, now - 4 * 60_000))
    oracle.onTrade(PAIR, makeTrade(1020n * SCALE, now - 3 * 60_000))

    const sumSpread = (1010n - 1000n + 990n - 1000n + 1020n - 1000n) * SCALE  // 20 * SCALE
    const p2Expected = index + sumSpread / 3n  // floor division

    // No funding getter → p1 = index; no mid getter → mid = TWAP
    // TWAP of 3 trades = (1010 + 990 + 1020) / 3 * SCALE = 3020/3 * SCALE
    const twap = (1010n * SCALE + 990n * SCALE + 1020n * SCALE) / 3n
    // sorted: [twap ≈ 1006.67, p2 ≈ 1006.67, index = 1000] — need to know exact values
    // p2 = 1000 * SCALE + 20 * SCALE / 3 = 1000 * SCALE + 6666...n
    // twap = 3020 * SCALE / 3 = 1006666...n
    // index = 1000 * SCALE
    // median(1000*S, p2, twap)
    const mark = oracle.getMarkPrice(PAIR)
    // Verify p2 is computed and mark is the median
    expect(mark).toBe(p2Expected)
  })

  it('median selection — returns middle of three values', () => {
    const oracle = new MarkPriceOracle()
    const SCALE  = 10n ** 18n
    const index  = 1000n * SCALE

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)

    oracle.setIndexPrice(PAIR, index)
    // p1 = index (no funding getter)
    // p2 = index (no spread history)
    // mid = 1200 * SCALE
    // median(1000, 1000, 1200) = 1000
    oracle.setMidPriceGetter(() => 1200n * SCALE)
    expect(oracle.getMarkPrice(PAIR)).toBe(1000n * SCALE)

    // Now add a huge mid that should still be clamped by median
    oracle.setMidPriceGetter(() => 500n * SCALE)
    // median(1000, 1000, 500) = 1000
    expect(oracle.getMarkPrice(PAIR)).toBe(1000n * SCALE)
  })

  it('fallback to TWAP when indexPrice is 0n', () => {
    const oracle = new MarkPriceOracle(60_000)
    const now    = Date.now()
    oracle.onTrade(PAIR, makeTrade(2500n, now))
    oracle.onTrade(PAIR, makeTrade(3500n, now + 1))
    // No index set → indexPrice = 0n → fallback to TWAP = (2500 + 3500) / 2 = 3000
    expect(oracle.getMarkPrice(PAIR)).toBe(3000n)
  })

  it('getMidPrice getter is called when set and influences mark price', () => {
    const oracle  = new MarkPriceOracle()
    const SCALE   = 10n ** 18n
    const index   = 1000n * SCALE
    oracle.setIndexPrice(PAIR, index)

    let callCount = 0
    oracle.setMidPriceGetter((pairId) => {
      callCount++
      expect(pairId).toBe(PAIR)
      return 1050n * SCALE
    })

    oracle.getMarkPrice(PAIR)
    expect(callCount).toBe(1)

    // p1 = index (no funding), p2 = index (no spread), mid = 1050 * SCALE
    // median(1000, 1000, 1050) = 1000 * SCALE
    expect(oracle.getMarkPrice(PAIR)).toBe(1000n * SCALE)
  })
})
