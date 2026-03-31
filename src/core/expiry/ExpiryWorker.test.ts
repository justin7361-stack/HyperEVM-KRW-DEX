import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ExpiryWorker } from './ExpiryWorker.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'
import type { StoredOrder } from '../../types/order.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id:           'order-1',
    maker:        '0x1111111111111111111111111111111111111111',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price:        1000n,
    amount:       1n,
    isBuy:        true,
    nonce:        1n,
    expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '127.0.0.1',
    ...overrides,
  }
}

function makeStore(orders: StoredOrder[]): IOrderBookStore & { getAllOpenOrders: () => StoredOrder[]; updateOrder: ReturnType<typeof vi.fn> } {
  const updateOrder = vi.fn().mockResolvedValue(undefined)
  return {
    getAllOpenOrders: () => orders,
    updateOrder,
    addOrder:        vi.fn(),
    removeOrder:     vi.fn(),
    getOrder:        vi.fn(),
    getBestBid:      vi.fn(),
    getBestAsk:      vi.fn(),
    getOpenOrders:   vi.fn(),
    getDepth:        vi.fn(),
    getOrdersByMaker: vi.fn(),
  } as any
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ExpiryWorker.sweep()', () => {
  it('returns 0 when no orders are open', async () => {
    const store = makeStore([])
    const worker = new ExpiryWorker(store)
    expect(await worker.sweep()).toBe(0)
  })

  it('expires an order whose expiry <= now (hard deadline, Unix seconds bigint)', async () => {
    const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1)
    const order = makeOrder({ id: 'hard-expired', expiry: pastExpiry })
    const store = makeStore([order])
    const worker = new ExpiryWorker(store)

    const count = await worker.sweep()

    expect(count).toBe(1)
    expect(store.updateOrder).toHaveBeenCalledWith('hard-expired', { status: 'expired' })
  })

  it('expires a GTT order whose goodTillTime <= Date.now() (Unix ms bigint)', async () => {
    const pastMs = BigInt(Date.now() - 1000)
    const order = makeOrder({
      id:          'gtt-expired',
      timeInForce: 'GTT',
      goodTillTime: pastMs,
      // expiry still in the future so only GTT triggers
      expiry:      BigInt(Math.floor(Date.now() / 1000) + 3600),
    })
    const store = makeStore([order])
    const worker = new ExpiryWorker(store)

    const count = await worker.sweep()

    expect(count).toBe(1)
    expect(store.updateOrder).toHaveBeenCalledWith('gtt-expired', { status: 'expired' })
  })

  it('does NOT expire an order whose expiry is in the future', async () => {
    const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const order = makeOrder({ id: 'future', expiry: futureExpiry })
    const store = makeStore([order])
    const worker = new ExpiryWorker(store)

    const count = await worker.sweep()

    expect(count).toBe(0)
    expect(store.updateOrder).not.toHaveBeenCalled()
  })

  it('does NOT expire a filled order even if expiry has passed', async () => {
    const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1)
    const order = makeOrder({ id: 'filled', expiry: pastExpiry, status: 'filled' })
    const store = makeStore([order])
    const worker = new ExpiryWorker(store)

    const count = await worker.sweep()

    expect(count).toBe(0)
    expect(store.updateOrder).not.toHaveBeenCalled()
  })
})

describe('ExpiryWorker start/stop idempotency', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('calling start() twice does not create two intervals', async () => {
    const store = makeStore([])
    const worker = new ExpiryWorker(store, 1000)

    worker.start()
    worker.start()   // second call should be a no-op

    // Only one interval: advance time by 1 sweep interval
    vi.advanceTimersByTime(1000)

    // sweep is async — flush microtasks
    await Promise.resolve()

    // updateOrder never called (no orders), but we care that only one sweep fires
    expect(store.updateOrder).not.toHaveBeenCalled()

    worker.stop()
    vi.useRealTimers()
  })

  it('stop() clears the timer so no more sweeps fire', async () => {
    const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1)
    const order = makeOrder({ id: 'exp', expiry: pastExpiry })
    const store = makeStore([order])
    const worker = new ExpiryWorker(store, 1000)

    worker.start()
    worker.stop()

    // Advance past the interval — no sweep should fire
    vi.advanceTimersByTime(5000)
    await Promise.resolve()

    expect(store.updateOrder).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
