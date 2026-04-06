import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { buildServer } from '../../src/api/server.js'
import type { FastifyInstance } from 'fastify'
import { EIP712Verifier } from '../../src/verification/EIP712Verifier.js'
import { PolicyEngine } from '../../src/compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from '../../src/compliance/plugins/BasicBlocklistPlugin.js'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import { MatchingEngine } from '../../src/core/matching/MatchingEngine.js'
import { TradeStore } from '../../src/api/routes/trades.js'
import type { Order } from '../../src/types/order.js'

const BASE  = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as Address
const QUOTE = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB' as Address
const CONTRACT = '0x0000000000000000000000000000000000000001' as Address
const CHAIN_ID  = 1337n

const DOMAIN = { name: 'KRW DEX' as const, version: '1' as const, chainId: CHAIN_ID, verifyingContract: CONTRACT }
const TYPES  = {
  Order: [
    { name: 'maker', type: 'address' }, { name: 'taker', type: 'address' },
    { name: 'baseToken', type: 'address' }, { name: 'quoteToken', type: 'address' },
    { name: 'price', type: 'uint256' }, { name: 'amount', type: 'uint256' },
    { name: 'isBuy', type: 'bool' }, { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const

function bigintReplacer(_: string, v: unknown) {
  return typeof v === 'bigint' ? v.toString() : v
}

async function signOrder(pk: `0x${string}`, order: Order) {
  const account = privateKeyToAccount(pk)
  return account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Order', message: order })
}

describe('API Integration', () => {
  const pk1  = generatePrivateKey()
  const acc1 = privateKeyToAccount(pk1)

  let server: FastifyInstance
  let store:  MemoryOrderBookStore

  beforeAll(async () => {
    store = new MemoryOrderBookStore()
    const matching = new MatchingEngine(store)
    const policy   = new PolicyEngine()
    policy.register(new BasicBlocklistPlugin(new Set()))

    // Mock pairRegistry: always returns true (all pairs allowed in tests)
    const pairRegistry = {
      read: {
        isTradeAllowed: async () => true,
      },
    } as any

    server = await buildServer({
      config:   { batchSize: 10, batchTimeoutMs: 1000 } as any,
      verifier: new EIP712Verifier(DOMAIN),
      policy, matching, store,
      trades:       new TradeStore(),
      pairRegistry,
    })
    await server.ready()
  })

  afterAll(() => server.close())

  it('POST /orders returns 201 for valid signed order', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 0n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }
    const sig = await signOrder(pk1, order)
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: sig }, bigintReplacer),
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toHaveProperty('orderId')
  })

  it('POST /orders returns 400 for expired order', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 1n, expiry: 1n,
    }
    const sig = await signOrder(pk1, order)
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: sig }, bigintReplacer),
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /orders returns 400 for invalid signature', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 2n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: '0xdeadbeef' }, bigintReplacer),
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /orderbook/:pair returns depth', async () => {
    const pair = encodeURIComponent(`${BASE}/${QUOTE}`)
    const res  = await server.inject({ method: 'GET', url: `/orderbook/${pair}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('bids')
    expect(body).toHaveProperty('asks')
  })

  it('GET /health returns ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('ok')
  })
})
