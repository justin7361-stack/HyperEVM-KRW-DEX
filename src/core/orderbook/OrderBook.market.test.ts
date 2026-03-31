import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const PAIR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'order-1', maker: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any,
    taker: '0x0000000000000000000000000000000000000000' as any,
    baseToken: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any,
    quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any,
    price: 100n, amount: 10n, isBuy: false, nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1',
    ...overrides,
  }
}

describe('Market Order', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook

  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('market buy matches limit sell at price 0', async () => {
    await store.addOrder(makeOrder({ id: 'sell-1', isBuy: false, price: 100n }))
    const matches = await book.submit(
      makeOrder({ id: 'buy-1', isBuy: true, price: 0n, amount: 10n, orderType: 'market', nonce: 2n })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
    expect(matches[0].price).toBe(100n)   // executes at limit price
  })

  it('market sell matches limit buy at bid price', async () => {
    await store.addOrder(makeOrder({ id: 'buy-1', isBuy: true, price: 100n, nonce: 2n }))
    const matches = await book.submit(
      makeOrder({ id: 'sell-1', isBuy: false, price: 0n, amount: 10n, orderType: 'market', nonce: 3n })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
    expect(matches[0].price).toBe(100n)   // executes at bid price, NOT 0n
  })

  it('market order with no liquidity → status cancelled (IOC)', async () => {
    await book.submit(makeOrder({ id: 'buy-1', isBuy: true, price: 0n, orderType: 'market', nonce: 2n }))
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })

  it('market order partial fill → remainder cancelled', async () => {
    await store.addOrder(makeOrder({ id: 'sell-1', isBuy: false, price: 100n, amount: 5n }))
    const matches = await book.submit(
      makeOrder({ id: 'buy-1', isBuy: true, price: 0n, amount: 10n, orderType: 'market', nonce: 2n })
    )
    expect(matches[0].fillAmount).toBe(5n)
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })

  it('market orders excluded from depth', async () => {
    await store.addOrder(makeOrder({ id: 'sell-1', isBuy: false, price: 100n }))
    await store.addOrder(makeOrder({ id: 'buy-1', isBuy: true, price: 0n, orderType: 'market', nonce: 2n }))
    const depth = await store.getDepth(PAIR, 10)
    expect(depth.bids).toHaveLength(0)
    expect(depth.asks).toHaveLength(1)
  })
})
