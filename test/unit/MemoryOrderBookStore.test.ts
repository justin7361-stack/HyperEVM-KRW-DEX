import { describe, it, expect, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import type { StoredOrder } from '../../src/types/order.js'

const PAIR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id:           uuid(),
    maker:        '0x1111111111111111111111111111111111111111',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price:        1350n * 10n ** 18n,
    amount:       1n * 10n ** 18n,
    isBuy:        true,
    nonce:        0n,
    expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '1.2.3.4',
    ...overrides,
  }
}

describe('MemoryOrderBookStore', () => {
  let store: MemoryOrderBookStore

  beforeEach(() => { store = new MemoryOrderBookStore() })

  it('adds and retrieves an order', async () => {
    const order = makeOrder()
    await store.addOrder(order)
    expect(await store.getOrder(order.id)).toMatchObject({ id: order.id })
  })

  it('removes an order', async () => {
    const order = makeOrder()
    await store.addOrder(order)
    await store.removeOrder(order.id)
    expect(await store.getOrder(order.id)).toBeUndefined()
  })

  it('getBestBid returns highest price bid', async () => {
    const low  = makeOrder({ id: uuid(), price: 1300n * 10n ** 18n, isBuy: true })
    const high = makeOrder({ id: uuid(), price: 1400n * 10n ** 18n, isBuy: true })
    await store.addOrder(low)
    await store.addOrder(high)
    const best = await store.getBestBid(PAIR)
    expect(best?.price).toBe(1400n * 10n ** 18n)
  })

  it('getBestAsk returns lowest price ask', async () => {
    const high = makeOrder({ id: uuid(), price: 1400n * 10n ** 18n, isBuy: false })
    const low  = makeOrder({ id: uuid(), price: 1300n * 10n ** 18n, isBuy: false })
    await store.addOrder(high)
    await store.addOrder(low)
    const best = await store.getBestAsk(PAIR)
    expect(best?.price).toBe(1300n * 10n ** 18n)
  })

  it('updates an order field', async () => {
    const order = makeOrder()
    await store.addOrder(order)
    await store.updateOrder(order.id, { filledAmount: 5n * 10n ** 17n, status: 'partial' })
    const updated = await store.getOrder(order.id)
    expect(updated?.filledAmount).toBe(5n * 10n ** 17n)
    expect(updated?.status).toBe('partial')
  })
})
