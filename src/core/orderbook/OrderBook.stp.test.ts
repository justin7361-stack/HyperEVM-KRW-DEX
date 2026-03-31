import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const SAME  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const OTHER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any
const PAIR  = `${SAME}/${OTHER}`

import type { StpMode } from '../../types/order.js'

function order(id: string, maker: any, isBuy: boolean, price: bigint, n: bigint, stp?: StpMode): StoredOrder {
  return {
    id, maker, taker: '0x0000000000000000000000000000000000000000' as any,
    baseToken: SAME, quoteToken: OTHER,
    price, amount: 10n, isBuy, nonce: n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1',
    stp,
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

  // Backward-compatibility check: no stp field defaults to EXPIRE_TAKER behaviour.
  // Already covered by the first test ('same maker self-trade → taker order cancelled,
  // no fill') which uses a plain order() call with no stp argument.

  it('EXPIRE_MAKER: resting maker cancelled, buy order remains open (no counterparty)', async () => {
    // Maker A places a limit sell (resting in the book)
    await store.addOrder(order('sell-1', SAME, false, 100n, 1n))
    // Maker A sends a buy with EXPIRE_MAKER — self-trade detected on sell-1
    const matches = await book.submit(order('buy-1', SAME, true, 100n, 2n, 'EXPIRE_MAKER'))
    // The resting sell should be cancelled, taker keeps looping but finds no more orders
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('sell-1'))?.status).toBe('cancelled')
    // Buy order is still open (nothing left to match against)
    expect((await store.getOrder('buy-1'))?.status).toBe('open')
  })

  it('EXPIRE_MAKER: resting self-order cancelled, taker fills against next available order', async () => {
    // Maker A places a limit sell at 100 (will trigger STP)
    await store.addOrder(order('sell-A', SAME,  false, 100n, 1n))
    // Maker B places a limit sell at 101 (non-self, will be matched after STP skips sell-A)
    await store.addOrder(order('sell-B', OTHER, false, 101n, 2n))
    // Maker A sends a buy at 101 with EXPIRE_MAKER
    const matches = await book.submit(order('buy-1', SAME, true, 101n, 3n, 'EXPIRE_MAKER'))
    // sell-A (self) cancelled; buy-1 then matches sell-B
    expect((await store.getOrder('sell-A'))?.status).toBe('cancelled')
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
    expect((await store.getOrder('buy-1'))?.status).toBe('filled')
    expect((await store.getOrder('sell-B'))?.status).toBe('filled')
  })

  it('EXPIRE_BOTH: both resting maker and incoming taker are cancelled, no fill', async () => {
    // Maker A places a limit sell (resting)
    await store.addOrder(order('sell-1', SAME, false, 100n, 1n))
    // Maker A sends a buy with EXPIRE_BOTH
    const matches = await book.submit(order('buy-1', SAME, true, 100n, 2n, 'EXPIRE_BOTH'))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('sell-1'))?.status).toBe('cancelled')
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })
})
