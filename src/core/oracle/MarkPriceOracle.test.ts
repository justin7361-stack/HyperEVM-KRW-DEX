import { describe, it, expect } from 'vitest'
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
})
