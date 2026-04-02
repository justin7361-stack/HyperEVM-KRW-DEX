import { describe, it, expect, vi } from 'vitest'
import { MatchingEngine } from './MatchingEngine.js'
import { MemoryOrderBookStore } from '../orderbook/MemoryOrderBookStore.js'
import { PositionTracker } from '../position/PositionTracker.js'
import type { StoredOrder } from '../../types/order.js'

const BASE  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`
const QUOTE = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`
const PAIR  = `${BASE}/${QUOTE}`

const MAKER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`
const MAKER_B = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as `0x${string}`

function makeOrder(o: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'o1', maker: MAKER_A, taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    baseToken: BASE, quoteToken: QUOTE,
    price: 100n, amount: 10n, isBuy: true, nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as `0x${string}`, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1', orderType: 'limit', ...o,
  }
}

describe('MatchingEngine — Reduce-Only (G-7)', () => {
  it('reduce-only sell allowed when maker has long position >= order amount', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()
    const engine  = new MatchingEngine(store, undefined, tracker)

    // Seed a resting BID so the reduce-only sell can match against it
    await store.addOrder(makeOrder({
      id: 'bid1', maker: MAKER_B, isBuy: true, price: 100n, amount: 10n, nonce: 10n,
    }))

    // Manually seed long position for MAKER_A: simulate 10 units long
    // by injecting directly (PositionTracker is stateful via onMatch)
    ;(tracker as any).pos.set(`${MAKER_A.toLowerCase()}:${PAIR}`, 10n)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    const matches: unknown[] = []
    engine.on('matched', (m: unknown) => matches.push(m))

    // reduce-only sell to close 10 of the long
    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(0)
    expect(matches).toHaveLength(1)
  })

  it('reduce-only sell rejected when maker has NO long position', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()  // empty — no position
    const engine  = new MatchingEngine(store, undefined, tracker)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain('reduce-only')
  })

  it('reduce-only sell rejected when position is short (wrong direction)', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()
    const engine  = new MatchingEngine(store, undefined, tracker)

    // MAKER_A is SHORT — reduce-only sell should be rejected (would increase exposure)
    ;(tracker as any).pos.set(`${MAKER_A.toLowerCase()}:${PAIR}`, -10n)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(1)
  })

  it('reduce-only sell rejected when amount exceeds long position size', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()
    const engine  = new MatchingEngine(store, undefined, tracker)

    // Long position is only 5, but reduce-only order is for 10
    ;(tracker as any).pos.set(`${MAKER_A.toLowerCase()}:${PAIR}`, 5n)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(1)
  })

  it('reduce-only buy allowed when maker has short position >= order amount', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()
    const engine  = new MatchingEngine(store, undefined, tracker)

    // Seed a resting ASK so the reduce-only buy can match against it
    await store.addOrder(makeOrder({
      id: 'ask1', maker: MAKER_B, isBuy: false, price: 100n, amount: 10n, nonce: 10n,
    }))

    // MAKER_A is SHORT 10 units
    ;(tracker as any).pos.set(`${MAKER_A.toLowerCase()}:${PAIR}`, -10n)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    const matches: unknown[] = []
    engine.on('matched', (m: unknown) => matches.push(m))

    // reduce-only buy to close 10 of the short
    await engine.submitOrder(
      makeOrder({ id: 'buy1', isBuy: true, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(0)
    expect(matches).toHaveLength(1)
  })

  it('reduce-only buy rejected when maker has NO short position', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()  // empty — no position
    const engine  = new MatchingEngine(store, undefined, tracker)

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'buy1', isBuy: true, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain('reduce-only')
  })

  it('reduce-only without positionReader configured → rejected with clear message', async () => {
    const store  = new MemoryOrderBookStore()
    const engine = new MatchingEngine(store)  // no positionReader

    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, reduceOnly: true, nonce: 2n }),
      PAIR,
    )

    expect(rejections).toHaveLength(1)
    expect(rejections[0]).toContain('no position reader')
  })

  it('non-reduce-only order is unaffected by positionReader (no position needed)', async () => {
    const store   = new MemoryOrderBookStore()
    const tracker = new PositionTracker()  // empty
    const engine  = new MatchingEngine(store, undefined, tracker)

    // Regular (non-reduce-only) sell with no position → should reach the book without rejection
    const rejections: string[] = []
    engine.on('rejected', (_id: string, reason: string) => rejections.push(reason))

    await engine.submitOrder(
      makeOrder({ id: 'sell1', isBuy: false, price: 100n, amount: 10n, nonce: 2n }),  // no reduceOnly
      PAIR,
    )

    expect(rejections).toHaveLength(0)
  })
})
