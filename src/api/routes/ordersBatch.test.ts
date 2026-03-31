import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { ordersBatchRoutes } from './ordersBatch.js'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { Clients } from '../../chain/contracts.js'

// ── Mock dependencies ──────────────────────────────────────────────────────

const verifier: IOrderVerifier = {
  verify: vi.fn().mockResolvedValue(true),
}

const policy = {
  check: vi.fn().mockResolvedValue({ allowed: true }),
} as unknown as PolicyEngine

const matching = {
  submitOrder: vi.fn().mockResolvedValue(undefined),
} as unknown as MatchingEngine

const store = {} as unknown as IOrderBookStore

const pairRegistry = {
  read: {
    isTradeAllowed: vi.fn().mockResolvedValue(true),
  },
} as unknown as Clients['pairRegistry']

// ── Helper to build a fresh Fastify app ────────────────────────────────────

function buildApp() {
  const fastify = Fastify({ logger: false })
  fastify.register(ordersBatchRoutes(verifier, policy, matching, store, pairRegistry))
  return fastify
}

// ── Valid order fixture ────────────────────────────────────────────────────

const futureExpiry = String(Math.floor(Date.now() / 1000) + 3600)

const validOrderItem = {
  order: {
    maker:      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    taker:      '0x0000000000000000000000000000000000000000',
    baseToken:  '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price:      '1000000000000000000',
    amount:     '500000000000000000',
    isBuy:      true,
    nonce:      '1',
    expiry:     futureExpiry,
  },
  signature: '0xdeadbeef' as `0x${string}`,
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('POST /orders/batch', () => {
  it('returns 400 when orders array is missing', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/orders/batch',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe('orders array required')
  })

  it('returns 400 when orders array is empty', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/orders/batch',
      payload: { orders: [] },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe('orders array required')
  })

  it('returns 400 when orders.length > 50', async () => {
    const app = buildApp()
    const orders = Array.from({ length: 51 }, () => validOrderItem)
    const res = await app.inject({
      method: 'POST',
      url: '/orders/batch',
      payload: { orders },
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toBe('Maximum 50 orders per batch')
  })

  it('returns 207 with orderId on successful order submission', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/orders/batch',
      payload: { orders: [validOrderItem] },
    })
    expect(res.statusCode).toBe(207)
    const body = res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].index).toBe(0)
    expect(typeof body.results[0].orderId).toBe('string')
    expect(body.results[0].error).toBeUndefined()
  })

  it('returns 207 with error when order is expired', async () => {
    const app = buildApp()
    const expiredItem = {
      ...validOrderItem,
      order: {
        ...validOrderItem.order,
        expiry: String(Math.floor(Date.now() / 1000) - 100), // past expiry
      },
    }
    const res = await app.inject({
      method: 'POST',
      url: '/orders/batch',
      payload: { orders: [expiredItem] },
    })
    expect(res.statusCode).toBe(207)
    const body = res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0].index).toBe(0)
    expect(body.results[0].error).toBe('Order expired')
    expect(body.results[0].orderId).toBeUndefined()
  })
})
