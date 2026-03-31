import { describe, it, expect, beforeEach } from 'vitest'
import { MemoryOrderBookStore } from './MemoryOrderBookStore.js'
import { OrderBook } from './OrderBook.js'
import type { StoredOrder } from '../../types/order.js'

const SAME  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`
const OTHER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`
const PAIR  = `${SAME}/${OTHER}`

import type { StpMode } from '../../types/order.js'

function order(params: {
  id: string
  maker: `0x${string}`
  isBuy: boolean
  price: bigint
  amount?: bigint
  nonce?: bigint
  stp?: StpMode
}): StoredOrder {
  const { id, maker, isBuy, price, amount = 10n, nonce = 1n, stp } = params
  return {
    id, maker, taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    baseToken: SAME, quoteToken: OTHER,
    price, amount, isBuy, nonce,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as `0x${string}`, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1',
    stp,
  }
}

describe('STP', () => {
  let store: MemoryOrderBookStore
  let ob: OrderBook
  beforeEach(() => { store = new MemoryOrderBookStore(); ob = new OrderBook(store, PAIR) })

  it('same maker self-trade → taker order cancelled, no fill', async () => {
    await store.addOrder(order({ id: 'sell-1', maker: SAME, isBuy: false, price: 100n }))
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 100n }))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
    // resting sell order should remain open
    expect((await store.getOrder('sell-1'))?.status).toBe('open')
  })

  it('different maker → normal fill', async () => {
    await store.addOrder(order({ id: 'sell-1', maker: OTHER, isBuy: false, price: 100n }))
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 100n }))
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
  })

  it('STP is case-insensitive for addresses', async () => {
    const lower = SAME.toLowerCase() as `0x${string}`
    await store.addOrder(order({ id: 'sell-1', maker: SAME, isBuy: false, price: 100n }))
    const matches = await ob.submit(order({ id: 'buy-1', maker: lower, isBuy: true, price: 100n }))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })

  // Backward-compatibility check: no stp field defaults to EXPIRE_TAKER behaviour.
  // Already covered by the first test ('same maker self-trade → taker order cancelled,
  // no fill') which uses a plain order() call with no stp argument.

  it('EXPIRE_MAKER: resting maker cancelled, buy order remains open (no counterparty)', async () => {
    // Maker A places a limit sell (resting in the book)
    await store.addOrder(order({ id: 'sell-1', maker: SAME, isBuy: false, price: 100n }))
    // Maker A sends a buy with EXPIRE_MAKER — self-trade detected on sell-1
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 100n, stp: 'EXPIRE_MAKER' }))
    // The resting sell should be cancelled, taker keeps looping but finds no more orders
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('sell-1'))?.status).toBe('cancelled')
    // Buy order is still open (nothing left to match against)
    expect((await store.getOrder('buy-1'))?.status).toBe('open')
  })

  it('EXPIRE_MAKER: resting self-order cancelled, taker fills against next available order', async () => {
    // Maker A places a limit sell at 100 (will trigger STP)
    await store.addOrder(order({ id: 'sell-A', maker: SAME,  isBuy: false, price: 100n }))
    // Maker B places a limit sell at 101 (non-self, will be matched after STP skips sell-A)
    await store.addOrder(order({ id: 'sell-B', maker: OTHER, isBuy: false, price: 101n }))
    // Maker A sends a buy at 101 with EXPIRE_MAKER
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 101n, stp: 'EXPIRE_MAKER' }))
    // sell-A (self) cancelled; buy-1 then matches sell-B
    expect((await store.getOrder('sell-A'))?.status).toBe('cancelled')
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(10n)
    expect((await store.getOrder('buy-1'))?.status).toBe('filled')
    expect((await store.getOrder('sell-B'))?.status).toBe('filled')
  })

  it('EXPIRE_BOTH: both resting maker and incoming taker are cancelled, no fill', async () => {
    // Maker A places a limit sell (resting)
    await store.addOrder(order({ id: 'sell-1', maker: SAME, isBuy: false, price: 100n }))
    // Maker A sends a buy with EXPIRE_BOTH
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 100n, stp: 'EXPIRE_BOTH' }))
    expect(matches).toHaveLength(0)
    expect((await store.getOrder('sell-1'))?.status).toBe('cancelled')
    expect((await store.getOrder('buy-1'))?.status).toBe('cancelled')
  })

  it('EXPIRE_TAKER explicit — same as default: taker cancelled, maker stays', async () => {
    await ob.submit(order({ id: 'sell-1', maker: SAME, isBuy: false, price: 100n, amount: 10n }))
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 100n, amount: 10n, stp: 'EXPIRE_TAKER' }))
    expect(matches).toHaveLength(0)
    const buy = await store.getOrder('buy-1')
    const sell = await store.getOrder('sell-1')
    expect(buy?.status).toBe('cancelled')
    expect(sell?.status).toBe('open')
  })

  it('EXPIRE_MAKER — partial fill from non-self order preserved when self-trade hit', async () => {
    // sell-B (OTHER maker) at 100, sell-A (SAME maker) at 101
    await ob.submit(order({ id: 'sell-B', maker: OTHER, isBuy: false, price: 100n, amount: 5n }))
    await ob.submit(order({ id: 'sell-A', maker: SAME,  isBuy: false, price: 101n, amount: 5n }))
    // buy-1 (SAME maker, EXPIRE_MAKER, amount=10): fills 5 against sell-B, then hits sell-A (self) → cancel sell-A, continue
    const matches = await ob.submit(order({ id: 'buy-1', maker: SAME, isBuy: true, price: 101n, amount: 10n, stp: 'EXPIRE_MAKER' }))
    // Should have 1 match (the fill against sell-B), sell-A cancelled
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(5n)
    const sellA = await store.getOrder('sell-A')
    expect(sellA?.status).toBe('cancelled')
  })
})
