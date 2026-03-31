import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { ordersRoutes } from './orders.js'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { StoredOrder } from '../../types/order.js'
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

const pairRegistry = {
  read: {
    isTradeAllowed: vi.fn().mockResolvedValue(true),
  },
} as unknown as Clients['pairRegistry']

// ── Valid order fixture ────────────────────────────────────────────────────

const MAKER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const futureExpiry = String(Math.floor(Date.now() / 1000) + 3600)

const baseOrderBody = {
  order: {
    maker:      MAKER,
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

// ── Tests: clientOrderId dedup ─────────────────────────────────────────────

describe('POST /orders — clientOrderId dedup', () => {
  it('returns 409 with Duplicate clientOrderId when the same clientOrderId is already open', async () => {
    const existingId = 'existing-uuid-1234'

    // Existing open order with the same clientOrderId
    const existingOrder: StoredOrder = {
      id:           existingId,
      maker:        MAKER,
      taker:        '0x0000000000000000000000000000000000000000',
      baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      price:        1000000000000000000n,
      amount:       500000000000000000n,
      isBuy:        true,
      nonce:        1n,
      expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
      signature:    '0xdeadbeef',
      submittedAt:  Date.now(),
      filledAmount: 0n,
      status:       'open',
      makerIp:      '127.0.0.1',
      clientOrderId: 'my-strat-001',
    }

    const store: IOrderBookStore = {
      getOrdersByMaker: vi.fn().mockResolvedValue([existingOrder]),
      addOrder:         vi.fn(),
      removeOrder:      vi.fn(),
      updateOrder:      vi.fn(),
      getOrder:         vi.fn(),
      getBestBid:       vi.fn(),
      getBestAsk:       vi.fn(),
      getOpenOrders:    vi.fn(),
      getDepth:         vi.fn(),
    }

    const fastify = Fastify({ logger: false })
    fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry))

    const res = await fastify.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        ...baseOrderBody,
        order: {
          ...baseOrderBody.order,
          clientOrderId: 'my-strat-001',
          nonce: '2',  // different nonce, same clientOrderId
        },
      },
    })

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('Duplicate clientOrderId')
    expect(body.orderId).toBe(existingId)
  })

  it('does not reject when clientOrderId is unique (not already open)', async () => {
    const store: IOrderBookStore = {
      getOrdersByMaker: vi.fn().mockResolvedValue([]),  // no existing orders
      addOrder:         vi.fn(),
      removeOrder:      vi.fn(),
      updateOrder:      vi.fn(),
      getOrder:         vi.fn(),
      getBestBid:       vi.fn(),
      getBestAsk:       vi.fn(),
      getOpenOrders:    vi.fn(),
      getDepth:         vi.fn(),
    }

    const fastify = Fastify({ logger: false })
    fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry))

    const res = await fastify.inject({
      method: 'POST',
      url: '/orders',
      payload: {
        ...baseOrderBody,
        order: {
          ...baseOrderBody.order,
          clientOrderId: 'my-strat-002',
        },
      },
    })

    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(typeof body.orderId).toBe('string')
  })

  it('does not reject when no clientOrderId is provided', async () => {
    const store: IOrderBookStore = {
      getOrdersByMaker: vi.fn().mockResolvedValue([]),
      addOrder:         vi.fn(),
      removeOrder:      vi.fn(),
      updateOrder:      vi.fn(),
      getOrder:         vi.fn(),
      getBestBid:       vi.fn(),
      getBestAsk:       vi.fn(),
      getOpenOrders:    vi.fn(),
      getDepth:         vi.fn(),
    }

    const fastify = Fastify({ logger: false })
    fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry))

    const res = await fastify.inject({
      method: 'POST',
      url: '/orders',
      payload: baseOrderBody,
    })

    expect(res.statusCode).toBe(201)
  })
})
