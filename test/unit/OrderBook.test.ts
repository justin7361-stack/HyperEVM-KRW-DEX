import { describe, it, expect, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { OrderBook } from '../../src/core/orderbook/OrderBook.js'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import type { StoredOrder } from '../../src/types/order.js'

const PAIR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function makeOrder(isBuy: boolean, price: bigint, amount = 1n * 10n ** 18n): StoredOrder {
  return {
    id:           uuid(),
    maker:        isBuy
      ? '0x1111111111111111111111111111111111111111'
      : '0x2222222222222222222222222222222222222222',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price,
    amount,
    isBuy,
    nonce:        BigInt(Math.floor(Math.random() * 1e9)),
    expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '1.2.3.4',
  }
}

describe('OrderBook', () => {
  let ob: OrderBook

  beforeEach(() => {
    const store = new MemoryOrderBookStore()
    ob = new OrderBook(store, PAIR)
  })

  it('returns empty matches when no counterparty', async () => {
    const bid = makeOrder(true, 1350n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(0)
  })

  it('matches a buy with a sell at exact price', async () => {
    const ask = makeOrder(false, 1350n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1350n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(1n * 10n ** 18n)
  })

  it('matches a buy at higher price with a lower ask (execution at ask price)', async () => {
    const ask = makeOrder(false, 1300n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1400n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    // execution at ask price (maker price)
    expect(matches[0].price).toBe(1300n * 10n ** 18n)
  })

  it('does not match when bid < ask', async () => {
    const ask = makeOrder(false, 1400n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1300n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(0)
  })

  it('partial fill: bid larger than ask leaves remainder in book', async () => {
    const ask = makeOrder(false, 1350n * 10n ** 18n, 1n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true,  1350n * 10n ** 18n, 3n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(1n * 10n ** 18n)
    // bid still in book with 2e18 remaining
    const depth = await ob.getDepth(5)
    expect(depth.bids[0].amount).toBe(2n * 10n ** 18n)
  })
})
