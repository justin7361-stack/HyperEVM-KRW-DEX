import { describe, it, expect, beforeEach } from 'vitest'
import { PositionTracker } from './PositionTracker.js'
import type { MatchResult, StoredOrder } from '../../types/order.js'

const MAKER = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any
const PAIR  = 'base/quote'

function match(makerIsBuy: boolean, fill: bigint): MatchResult {
  const o = (isBuy: boolean): StoredOrder => ({
    id: 'x', maker: MAKER, taker: '0x0' as any,
    baseToken: '0xA' as any, quoteToken: '0xB' as any,
    price: 100n, amount: fill, isBuy, nonce: 1n,
    expiry: 99999999n, signature: '0x' as any,
    submittedAt: 0, filledAmount: fill, status: 'filled', makerIp: '',
  })
  return {
    makerOrder: o(makerIsBuy),
    takerOrder: o(!makerIsBuy),
    fillAmount: fill, price: 100n, matchedAt: 0,
  }
}

describe('PositionTracker', () => {
  let tracker: PositionTracker
  beforeEach(() => { tracker = new PositionTracker() })

  it('buy fill → positive position', () => {
    tracker.onMatch(PAIR, match(true, 10n))
    expect(tracker.getPosition(MAKER, PAIR)).toBe(10n)
  })

  it('sell fill → decreases position', () => {
    tracker.onMatch(PAIR, match(true, 10n))
    tracker.onMatch(PAIR, match(false, 4n))
    expect(tracker.getPosition(MAKER, PAIR)).toBe(6n)
  })

  it('canReduceOnly sell: long position >= amount → true', () => {
    tracker.onMatch(PAIR, match(true, 10n))
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(true)
  })

  it('canReduceOnly sell: no position → false', () => {
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(false)
  })

  it('canReduceOnly sell: sell > position → false', () => {
    tracker.onMatch(PAIR, match(true, 3n))
    expect(tracker.canReduceOnly(MAKER, PAIR, false, 5n)).toBe(false)
  })

  it('canReduceOnly buy: short position → true', () => {
    tracker.onMatch(PAIR, match(false, 10n))
    expect(tracker.canReduceOnly(MAKER, PAIR, true, 5n)).toBe(true)
  })

  it('canReduceOnly buy: no short position → false', () => {
    expect(tracker.canReduceOnly(MAKER, PAIR, true, 5n)).toBe(false)
  })
})
