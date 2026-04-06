import { describe, it, expect, beforeEach } from 'vitest'
import { PositionTracker } from './PositionTracker.js'
import type { MatchResult, StoredOrder } from '../../types/order.js'

const MAKER  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const TAKER  = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any
const PAIR   = 'base/quote'

// Price and amount are 1e18-scaled for realistic margin math
const PRICE_1E18 = 100n * 10n ** 18n   // 100 quote per base (scaled)
const FILL_1E18  =  10n * 10n ** 18n   // 10 base tokens (scaled)
// Expected notional = fillAmount * price / 1e18 = 10 * 100 = 1000 quote (scaled)

function makeOrder(maker: any, isBuy: boolean, fill: bigint, price = PRICE_1E18, leverage = 1n): StoredOrder {
  return {
    id: 'x', maker, taker: '0x0' as any,
    baseToken: '0xA' as any, quoteToken: '0xB' as any,
    price, amount: fill, isBuy, nonce: 1n,
    expiry: 99999999n, signature: '0x' as any,
    submittedAt: 0, filledAmount: fill, status: 'filled', makerIp: '',
    leverage,
  }
}

function match(makerIsBuy: boolean, fill: bigint, price = PRICE_1E18, leverage = 1n): MatchResult {
  return {
    makerOrder: makeOrder(MAKER, makerIsBuy, fill, price, leverage),
    takerOrder: makeOrder(TAKER, !makerIsBuy, fill, price, leverage),
    fillAmount: fill,
    price,
    matchedAt: 0,
  }
}

// For tests that only check size (use small raw numbers, not 1e18-scaled)
// IMPORTANT: makerOrder.maker = MAKER, takerOrder.maker = TAKER (different addresses!)
function matchSmall(makerIsBuy: boolean, fill: bigint): MatchResult {
  const makerOrder: StoredOrder = {
    id: 'x', maker: MAKER, taker: '0x0' as any,
    baseToken: '0xA' as any, quoteToken: '0xB' as any,
    price: 100n, amount: fill, isBuy: makerIsBuy, nonce: 1n,
    expiry: 99999999n, signature: '0x' as any,
    submittedAt: 0, filledAmount: fill, status: 'filled', makerIp: '',
  }
  const takerOrder: StoredOrder = {
    id: 'y', maker: TAKER, taker: '0x0' as any,
    baseToken: '0xA' as any, quoteToken: '0xB' as any,
    price: 100n, amount: fill, isBuy: !makerIsBuy, nonce: 2n,
    expiry: 99999999n, signature: '0x' as any,
    submittedAt: 0, filledAmount: fill, status: 'filled', makerIp: '',
  }
  return { makerOrder, takerOrder, fillAmount: fill, price: 100n, matchedAt: 0 }
}

describe('PositionTracker — size tracking', () => {
  let tracker: PositionTracker
  beforeEach(() => { tracker = new PositionTracker() })

  it('buy fill → positive position for maker', () => {
    tracker.onMatch(PAIR, matchSmall(true, 10n))
    expect(tracker.getPosition(MAKER, PAIR)).toBe(10n)
  })

  it('sell fill → decreases maker position', () => {
    tracker.onMatch(PAIR, matchSmall(true, 10n))
    tracker.onMatch(PAIR, matchSmall(false, 4n))
    expect(tracker.getPosition(MAKER, PAIR)).toBe(6n)
  })

  it('canReduceOnly sell: long position >= amount → true', () => {
    tracker.onMatch(PAIR, matchSmall(true, 10n))
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(true)
  })

  it('canReduceOnly sell: no position → false', () => {
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(false)
  })

  it('canReduceOnly sell: sell > position → false', () => {
    tracker.onMatch(PAIR, matchSmall(true, 3n))
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(false)
  })

  it('canReduceOnly buy: short position → true', () => {
    tracker.onMatch(PAIR, matchSmall(false, 10n))
    expect(tracker.canReduceOnly(MAKER, PAIR, true, 5n)).toBe(true)
  })

  it('canReduceOnly buy: no short position → false', () => {
    expect(tracker.canReduceOnly(MAKER, PAIR, true, 5n)).toBe(false)
  })
})

describe('PositionTracker — CR-2: taker position tracking', () => {
  let tracker: PositionTracker
  beforeEach(() => { tracker = new PositionTracker() })

  it('taker has opposite position to maker (buy match)', () => {
    tracker.onMatch(PAIR, matchSmall(true, 10n))  // maker buys, taker sells
    expect(tracker.getPosition(MAKER, PAIR)).toBe(10n)
    expect(tracker.getPosition(TAKER, PAIR)).toBe(-10n)   // taker is short
  })

  it('taker has opposite position to maker (sell match)', () => {
    tracker.onMatch(PAIR, matchSmall(false, 8n))  // maker sells, taker buys
    expect(tracker.getPosition(MAKER, PAIR)).toBe(-8n)
    expect(tracker.getPosition(TAKER, PAIR)).toBe(8n)
  })

  it('taker accumulates across multiple matches', () => {
    tracker.onMatch(PAIR, matchSmall(true, 10n))   // taker: -10
    tracker.onMatch(PAIR, matchSmall(true, 5n))    // taker: -15
    expect(tracker.getPosition(TAKER, PAIR)).toBe(-15n)
  })
})

describe('PositionTracker — CR-1: getAll() margin > 0n', () => {
  let tracker: PositionTracker
  beforeEach(() => { tracker = new PositionTracker() })

  it('getAll() returns margin > 0n for open positions (prevents liquidation storm)', () => {
    tracker.onMatch(PAIR, match(true, FILL_1E18))

    const positions = tracker.getAll()
    const makerPos  = positions.find(p => p.maker.toLowerCase() === MAKER.toLowerCase())
    const takerPos  = positions.find(p => p.maker.toLowerCase() === TAKER.toLowerCase())

    // CR-1 fix: margin must be > 0n
    expect(makerPos).toBeDefined()
    expect(makerPos!.margin).toBeGreaterThan(0n)
    expect(takerPos).toBeDefined()
    expect(takerPos!.margin).toBeGreaterThan(0n)
  })

  it('getAll() includes both maker and taker positions', () => {
    tracker.onMatch(PAIR, match(true, FILL_1E18))

    const positions = tracker.getAll()
    const makers = positions.map(p => p.maker.toLowerCase())
    expect(makers).toContain(MAKER.toLowerCase())
    expect(makers).toContain(TAKER.toLowerCase())
  })

  it('margin grows when position increases', () => {
    tracker.onMatch(PAIR, match(true, FILL_1E18))
    const before = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    tracker.onMatch(PAIR, match(true, FILL_1E18))
    const after = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    expect(after).toBeGreaterThan(before)
  })

  it('margin is proportionally reduced when position is partially closed', () => {
    // Open: buy 10 BTC
    tracker.onMatch(PAIR, match(true, FILL_1E18))
    const openMargin = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    // Close half: sell 5 BTC (using a separate match where maker is now the seller)
    tracker.onMatch(PAIR, match(false, FILL_1E18 / 2n))
    const halfMargin = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    // After selling half, remaining margin should be less than original
    expect(halfMargin).toBeLessThan(openMargin)
    expect(halfMargin).toBeGreaterThan(0n)
  })

  it('fully closed position is removed from getAll()', () => {
    tracker.onMatch(PAIR, match(true, FILL_1E18))        // open long 10
    tracker.onMatch(PAIR, match(false, FILL_1E18))       // close all

    const positions = tracker.getAll()
    // Fully closed position should no longer appear in getAll() (entry deleted)
    const makerPos  = positions.find(p => p.maker.toLowerCase() === MAKER.toLowerCase())
    expect(makerPos).toBeUndefined()

    // getPosition() should return 0n
    expect(tracker.getPosition(MAKER, PAIR)).toBe(0n)
  })

  it('leverage reduces margin required per unit', () => {
    // 1x leverage — higher margin
    tracker.onMatch(PAIR, match(true, FILL_1E18, PRICE_1E18, 1n))
    const margin1x = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    // Reset
    const tracker2 = new PositionTracker()
    // 10x leverage — lower margin
    tracker2.onMatch(PAIR, match(true, FILL_1E18, PRICE_1E18, 10n))
    const margin10x = tracker2.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())!.margin

    expect(margin1x).toBeGreaterThan(margin10x)
  })

  it('getAll() returns correct mode from order', () => {
    const m = match(true, FILL_1E18)
    // Override margin mode to isolated
    ;(m.makerOrder as any).marginMode = 'isolated'
    tracker.onMatch(PAIR, m)

    const pos = tracker.getAll().find(p => p.maker.toLowerCase() === MAKER.toLowerCase())
    expect(pos?.mode).toBe('isolated')
  })
})
