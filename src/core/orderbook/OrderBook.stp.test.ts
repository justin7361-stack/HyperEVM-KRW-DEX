import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const SAME  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const OTHER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any
const PAIR  = `${SAME}/${OTHER}`

function order(id: string, maker: any, isBuy: boolean, price: bigint, n: bigint): StoredOrder {
  return {
    id, maker, taker: '0x0000000000000000000000000000000000000000' as any,
    baseToken: SAME, quoteToken: OTHER,
    price, amount: 10n, isBuy, nonce: n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1',
  }
}

describe('STP', () => {
  let store: MemoryOrderBookStore
  let book: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); book = new OrderBook(store, PAIR) })

  it('same maker self-trade → taker order cancelled, no fill', async () => {
    await store.addOrder(order('sell-1', SAME, false, 100n, 1n))
    const matches = await book.submit(order('buy-1', SAME, true, 100n, 2n))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
    // resting sell order should remain open
    expect((await store.getOrder('sell-1'))?.status).toBe('open')
  })

  it('different maker → normal fill', async () => {
    await store.addOrder(order('sell-1', OTHER, false, 100n, 1n))
    const matches = await book.submit(order('buy-1', SAME, true, 100n, 2n))
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
  })

  it('STP is case-insensitive for addresses', async () => {
    const lower = SAME.toLowerCase() as any
    await store.addOrder(order('sell-1', SAME, false, 100n, 1n))
    const matches = await book.submit(order('buy-1', lower, true, 100n, 2n))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })
})
