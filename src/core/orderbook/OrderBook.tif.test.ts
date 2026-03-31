import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const BASE  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const QUOTE = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any
const PAIR  = `${BASE}/${QUOTE}`

function makeOrder(o: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'o1', maker: BASE, taker: '0x0000000000000000000000000000000000000000' as any,
    baseToken: BASE, quoteToken: QUOTE,
    price: 100n, amount: 10n, isBuy: true, nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1', ...o,
  }
}

describe('FOK', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('FOK: full liquidity available → fills completely', async () => {
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 10n, nonce: 10n }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK' })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
  })

  it('FOK: insufficient liquidity → cancelled with no fills', async () => {
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 5n, nonce: 10n }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK' })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('FOK: no liquidity → cancelled', async () => {
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK' })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })
})

describe('Post-Only', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('Post-Only: would cross spread → cancelled immediately', async () => {
    // ask at 100; post-only buy at 100 would immediately take → cancel
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 10n, nonce: 10n }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'POST_ONLY' })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('Post-Only: does not cross spread → rests in book', async () => {
    // ask at 101; buy at 100 does not cross → rests
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 101n, amount: 10n, nonce: 10n }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'POST_ONLY' })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('open')
  })
})
