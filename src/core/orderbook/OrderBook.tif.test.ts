import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const BASE  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const QUOTE = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any
const PAIR  = `${BASE}/${QUOTE}`
const MAKER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const MAKER_B = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as any

function makeOrder(o: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'o1', maker: MAKER_A, taker: '0x0000000000000000000000000000000000000000' as any,
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
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 10n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
  })

  it('FOK: insufficient liquidity → cancelled with no fills', async () => {
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 5n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('FOK: no liquidity → cancelled', async () => {
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'FOK', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })
})

describe('IOC (Immediate Or Cancel)', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('IOC: full fill when liquidity equals order size', async () => {
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 10n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'IOC', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
    expect((await store.getOrder('b1'))?.status).toBe('filled')
  })

  it('IOC: partial fill — matches what is available, cancels unfilled remainder', async () => {
    // Only 6 available, order is for 10 → partial fill of 6, remainder cancelled
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 6n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'IOC', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(6n)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('IOC: no matching liquidity → cancelled immediately with no fills', async () => {
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'IOC', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('IOC: does NOT rest in book (cancelled even if price is better than market)', async () => {
    // No asks exist — IOC buy at very high price should still be cancelled
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 999n, amount: 10n, timeInForce: 'IOC', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    const order = await store.getOrder('b1')
    expect(order?.status).toBe('cancelled')
  })
})

describe('Post-Only', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('Post-Only: would cross spread → cancelled immediately', async () => {
    // ask at 100; post-only buy at 100 would immediately take → cancel
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 100n, amount: 10n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'POST_ONLY', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('cancelled')
  })

  it('Post-Only: does not cross spread → rests in book', async () => {
    // ask at 101; buy at 100 does not cross → rests
    await store.addOrder(makeOrder({ id: 's1', isBuy: false, price: 101n, amount: 10n, nonce: 10n, maker: MAKER_B }))
    const matches = await book.submit(
      makeOrder({ id: 'b1', isBuy: true, price: 100n, amount: 10n, timeInForce: 'POST_ONLY', nonce: 2n, maker: MAKER_A })
    )
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('b1'))?.status).toBe('open')
  })
})
