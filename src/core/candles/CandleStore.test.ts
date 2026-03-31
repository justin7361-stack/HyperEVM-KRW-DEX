import { describe, it, expect, beforeEach } from 'vitest'
import { CandleStore } from './CandleStore.js'
import type { TradeRecord } from '../../types/order.js'

const PAIR = 'ETH/KRW'

// Helper: compute bucket openTime for a given tradedAt and resolution ms
function bucketStart(tradedAt: number, resMs: number): number {
  return Math.floor(tradedAt / resMs) * resMs
}

const RES_1M = 60_000
const RES_5M = 300_000

// Pick a tradedAt that falls cleanly at the start of a 1m bucket
// 1_700_000_040_000 / 60_000 = 28_333_334.0 exactly → openTime = 1_700_000_040_000
const TRADE_AT_1 = 1_700_000_040_000  // bucket start
const TRADE_AT_2 = TRADE_AT_1 + 30_000   // same 1m bucket (+30s)
const TRADE_AT_NEXT_MIN = TRADE_AT_1 + 60_000  // next 1m bucket
const TRADE_AT_MIN_3   = TRADE_AT_1 + 120_000  // third 1m bucket

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id:           'trade-1',
    pairId:       PAIR,
    price:        1000n,
    amount:       10n,
    isBuyerMaker: true,
    tradedAt:     TRADE_AT_1,
    ...overrides,
  }
}

describe('CandleStore', () => {
  let store: CandleStore

  beforeEach(() => {
    store = new CandleStore()
  })

  it('onTrade() creates a new candle with correct OHLCV for the first trade', () => {
    const trade = makeTrade({ price: 500n, amount: 20n, tradedAt: TRADE_AT_1 })
    store.onTrade(PAIR, trade)

    const open = bucketStart(TRADE_AT_1, RES_1M)
    const candles = store.get(PAIR, '1m', open, open + RES_1M)
    expect(candles).toHaveLength(1)
    const c = candles[0]
    expect(c.open).toBe(500n)
    expect(c.high).toBe(500n)
    expect(c.low).toBe(500n)
    expect(c.close).toBe(500n)
    expect(c.volume).toBe(20n)
    expect(c.tradeCount).toBe(1)
  })

  it('second trade in same candle period updates high/low/close/volume/tradeCount', () => {
    const t1 = makeTrade({ price: 1000n, amount: 5n,  tradedAt: TRADE_AT_1 })
    const t2 = makeTrade({ price: 1200n, amount: 15n, tradedAt: TRADE_AT_2 })
    store.onTrade(PAIR, t1)
    store.onTrade(PAIR, t2)

    const open = bucketStart(TRADE_AT_1, RES_1M)
    const candles = store.get(PAIR, '1m', open, open + RES_1M)
    expect(candles).toHaveLength(1)
    const c = candles[0]
    expect(c.open).toBe(1000n)
    expect(c.high).toBe(1200n)
    expect(c.low).toBe(1000n)
    expect(c.close).toBe(1200n)
    expect(c.volume).toBe(20n)
    expect(c.tradeCount).toBe(2)
  })

  it('trade in different period creates a separate candle', () => {
    const t1 = makeTrade({ tradedAt: TRADE_AT_1 })
    const t2 = makeTrade({ tradedAt: TRADE_AT_NEXT_MIN })
    store.onTrade(PAIR, t1)
    store.onTrade(PAIR, t2)

    const open1 = bucketStart(TRADE_AT_1, RES_1M)
    const open2 = bucketStart(TRADE_AT_NEXT_MIN, RES_1M)
    const candles = store.get(PAIR, '1m', open1, open2 + RES_1M)
    expect(candles).toHaveLength(2)
    expect(candles[0].openTime).not.toBe(candles[1].openTime)
  })

  it('get() filters by resolution, pairId, start/end correctly', () => {
    const trade = makeTrade({ tradedAt: TRADE_AT_1 })
    store.onTrade(PAIR, trade)
    store.onTrade('BTC/KRW', makeTrade({ pairId: 'BTC/KRW', tradedAt: TRADE_AT_1 }))

    const open1m = bucketStart(TRADE_AT_1, RES_1M)
    const open5m = bucketStart(TRADE_AT_1, RES_5M)

    // Correct pair, correct resolution
    const eth1m = store.get(PAIR, '1m', open1m, open1m + RES_1M)
    expect(eth1m).toHaveLength(1)
    expect(eth1m[0].pairId).toBe(PAIR)

    // Different pair
    const btc1m = store.get('BTC/KRW', '1m', open1m, open1m + RES_1M)
    expect(btc1m).toHaveLength(1)
    expect(btc1m[0].pairId).toBe('BTC/KRW')

    // Different resolution (5m)
    const eth5m = store.get(PAIR, '5m', open5m, open5m + RES_5M)
    expect(eth5m).toHaveLength(1)
    expect(eth5m[0].resolution).toBe('5m')

    // Out of range
    const none = store.get(PAIR, '1m', 0, 1_000_000_000)
    expect(none).toHaveLength(0)
  })

  it('get() returns candles sorted by openTime', () => {
    // Insert trades out of order
    store.onTrade(PAIR, makeTrade({ tradedAt: TRADE_AT_MIN_3 }))    // minute 3
    store.onTrade(PAIR, makeTrade({ tradedAt: TRADE_AT_1 }))          // minute 1
    store.onTrade(PAIR, makeTrade({ tradedAt: TRADE_AT_NEXT_MIN }))   // minute 2

    const open1 = bucketStart(TRADE_AT_1, RES_1M)
    const open3 = bucketStart(TRADE_AT_MIN_3, RES_1M)
    const candles = store.get(PAIR, '1m', open1, open3 + RES_1M)
    expect(candles).toHaveLength(3)
    expect(candles[0].openTime).toBeLessThan(candles[1].openTime)
    expect(candles[1].openTime).toBeLessThan(candles[2].openTime)
  })

  it('price above existing high updates high; price below existing low updates low', () => {
    store.onTrade(PAIR, makeTrade({ price: 1000n, tradedAt: TRADE_AT_1 }))
    store.onTrade(PAIR, makeTrade({ price: 1500n, tradedAt: TRADE_AT_1 + 10_000 })) // new high
    store.onTrade(PAIR, makeTrade({ price: 800n,  tradedAt: TRADE_AT_1 + 20_000 })) // new low

    const open = bucketStart(TRADE_AT_1, RES_1M)
    const candles = store.get(PAIR, '1m', open, open + RES_1M)
    expect(candles).toHaveLength(1)
    expect(candles[0].high).toBe(1500n)
    expect(candles[0].low).toBe(800n)
    expect(candles[0].close).toBe(800n)
  })
})
