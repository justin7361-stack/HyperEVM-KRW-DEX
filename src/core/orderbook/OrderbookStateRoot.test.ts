import { describe, it, expect } from 'vitest'
import { computeOrderbookStateRoot } from './OrderbookStateRoot.js'
import type { StoredOrder } from '../../types/order.js'

const ZERO_ROOT = `0x${'0'.repeat(64)}`

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id:           'order-1',
    maker:        '0xDeadBeef00000000000000000000000000000001',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price:        1000n * 10n ** 18n,
    amount:       1n   * 10n ** 18n,
    isBuy:        true,
    nonce:        1n,
    expiry:       9999999999n,
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '127.0.0.1',
    ...overrides,
  }
}

const PAIR_ID = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

describe('computeOrderbookStateRoot', () => {
  it('returns zero root when no open orders exist', () => {
    expect(computeOrderbookStateRoot([], PAIR_ID)).toBe(ZERO_ROOT)
  })

  it('excludes filled/cancelled orders', () => {
    const filled    = makeOrder({ id: 'a', status: 'filled' })
    const cancelled = makeOrder({ id: 'b', status: 'cancelled' })
    expect(computeOrderbookStateRoot([filled, cancelled], PAIR_ID)).toBe(ZERO_ROOT)
  })

  it('excludes orders from other pairs', () => {
    const other = makeOrder({
      id:        'x',
      baseToken: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    })
    expect(computeOrderbookStateRoot([other], PAIR_ID)).toBe(ZERO_ROOT)
  })

  it('returns a non-zero 32-byte hex string for at least one open order', () => {
    const root = computeOrderbookStateRoot([makeOrder()], PAIR_ID)
    expect(root).not.toBe(ZERO_ROOT)
    expect(root).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('is deterministic — same orders → same root', () => {
    const orders = [
      makeOrder({ id: 'order-1', price: 1000n * 10n ** 18n }),
      makeOrder({ id: 'order-2', price: 2000n * 10n ** 18n, isBuy: false }),
    ]
    const root1 = computeOrderbookStateRoot(orders, PAIR_ID)
    const root2 = computeOrderbookStateRoot([...orders].reverse(), PAIR_ID)
    expect(root1).toBe(root2)   // order-independent (sorted by id)
  })

  it('changes when an order is added', () => {
    const one = [makeOrder({ id: 'order-1' })]
    const two = [...one, makeOrder({ id: 'order-2', price: 2000n * 10n ** 18n })]
    expect(computeOrderbookStateRoot(one, PAIR_ID)).not.toBe(computeOrderbookStateRoot(two, PAIR_ID))
  })

  it('changes when filledAmount changes (remaining amount changes)', () => {
    const full    = makeOrder({ id: 'order-1', filledAmount: 0n })
    const partial = makeOrder({ id: 'order-1', filledAmount: 5n * 10n ** 17n, status: 'partial' })
    expect(computeOrderbookStateRoot([full], PAIR_ID)).not.toBe(
      computeOrderbookStateRoot([partial], PAIR_ID),
    )
  })

  it('changes when price changes', () => {
    const low  = makeOrder({ id: 'order-1', price: 1000n * 10n ** 18n })
    const high = makeOrder({ id: 'order-1', price: 2000n * 10n ** 18n })
    expect(computeOrderbookStateRoot([low], PAIR_ID)).not.toBe(
      computeOrderbookStateRoot([high], PAIR_ID),
    )
  })

  it('sorts by id — swapping ids changes the root', () => {
    const a = makeOrder({ id: 'aaa', price: 1000n * 10n ** 18n })
    const b = makeOrder({ id: 'bbb', price: 2000n * 10n ** 18n })
    // Swapping id+price: order-b has id=aaa, order-a has id=bbb → different leaves
    const swapped = [
      makeOrder({ id: 'aaa', price: 2000n * 10n ** 18n }),
      makeOrder({ id: 'bbb', price: 1000n * 10n ** 18n }),
    ]
    expect(computeOrderbookStateRoot([a, b], PAIR_ID)).not.toBe(
      computeOrderbookStateRoot(swapped, PAIR_ID),
    )
  })
})
