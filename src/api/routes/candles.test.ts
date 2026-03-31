import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { candlesRoutes } from './candles.js'
import { CandleStore } from '../../core/candles/CandleStore.js'
import type { TradeRecord } from '../../types/order.js'

function buildApp(candleStore: CandleStore) {
  const fastify = Fastify()
  fastify.register(candlesRoutes(candleStore))
  return fastify
}

// tradedAt aligned to a 1m bucket boundary
const RES_1M_MS = 60_000
const TRADE_AT = 1_700_000_040_000  // exactly divisible by 60_000
const OPEN_TIME = Math.floor(TRADE_AT / RES_1M_MS) * RES_1M_MS  // == TRADE_AT

describe('GET /candles/:pair', () => {
  let store: CandleStore

  beforeEach(() => {
    store = new CandleStore()
  })

  it('returns 400 for invalid resolution', async () => {
    const app = buildApp(store)
    const res = await app.inject({
      method: 'GET',
      url: '/candles/ETH%2FKRW?resolution=999m',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/resolution must be one of/)
  })

  it('returns 200 with candles array and bigint fields as strings', async () => {
    const pairId = 'ETH/KRW'
    const trade: TradeRecord = {
      id: 'trade-1',
      pairId,
      price: 1_000_000_000_000_000_000n,
      amount: 500_000_000_000_000_000n,
      isBuyerMaker: true,
      tradedAt: TRADE_AT,
    }
    store.onTrade(pairId, trade)

    const app = buildApp(store)
    const start = OPEN_TIME
    const end   = OPEN_TIME + RES_1M_MS

    const res = await app.inject({
      method: 'GET',
      url: `/candles/${encodeURIComponent(pairId)}?resolution=1m&start=${start}&end=${end}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.candles).toHaveLength(1)
    const c = body.candles[0]
    // bigint fields should be strings
    expect(typeof c.open).toBe('string')
    expect(typeof c.high).toBe('string')
    expect(typeof c.low).toBe('string')
    expect(typeof c.close).toBe('string')
    expect(typeof c.volume).toBe('string')
    expect(c.open).toBe('1000000000000000000')
    expect(c.volume).toBe('500000000000000000')
  })

  it('excludes candles outside the explicit start/end window', async () => {
    const pairId = 'ETH/KRW'
    const insideTradeAt  = TRADE_AT                  // inside window
    const outsideTradeAt = TRADE_AT - RES_1M_MS * 2  // two buckets before start — outside window

    const insideTrade: TradeRecord = {
      id: 'trade-inside',
      pairId,
      price: 1_000_000_000_000_000_000n,
      amount: 1_000_000_000_000_000_000n,
      isBuyerMaker: true,
      tradedAt: insideTradeAt,
    }
    const outsideTrade: TradeRecord = {
      id: 'trade-outside',
      pairId,
      price: 2_000_000_000_000_000_000n,
      amount: 1_000_000_000_000_000_000n,
      isBuyerMaker: false,
      tradedAt: outsideTradeAt,
    }
    store.onTrade(pairId, insideTrade)
    store.onTrade(pairId, outsideTrade)

    const app = buildApp(store)
    const start = OPEN_TIME
    const end   = OPEN_TIME + RES_1M_MS

    const res = await app.inject({
      method: 'GET',
      url: `/candles/${encodeURIComponent(pairId)}?resolution=1m&start=${start}&end=${end}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.candles).toHaveLength(1)
  })

  it('defaults: no start/end params uses last 24h window and returns candles within', async () => {
    const pairId = 'ETH/KRW'
    const now = Date.now()
    // Trade 1 hour ago — should be within the 24h default window
    const trade: TradeRecord = {
      id: 'trade-now',
      pairId,
      price: 2000n,
      amount: 1n,
      isBuyerMaker: false,
      tradedAt: now - 3_600_000, // 1 hour ago
    }
    store.onTrade(pairId, trade)

    const app = buildApp(store)
    const res = await app.inject({
      method: 'GET',
      url: `/candles/${encodeURIComponent(pairId)}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The trade is within the last 24h so it must appear
    expect(body.candles.length).toBeGreaterThanOrEqual(1)
  })
})
