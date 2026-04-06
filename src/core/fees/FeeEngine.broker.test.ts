import { describe, it, expect } from 'vitest'
import { FeeEngine } from './FeeEngine.js'
import type { MatchResult, StoredOrder } from '../../types/order.js'

const BASE  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`
const QUOTE = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`
const PAIR_ID = `${BASE}/${QUOTE}`
const BROKER = '0xBROKER00000000000000000000000000000001'

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id:           'o1',
    maker:        '0xDeadBeef00000000000000000000000000000001',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    BASE,
    quoteToken:   QUOTE,
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

function makeMatch(
  takerOverrides: Partial<StoredOrder> = {},
  price = 1000n * 10n ** 18n,
  fillAmount = 1n * 10n ** 18n,
): MatchResult {
  return {
    makerOrder: makeOrder({ id: 'maker', isBuy: true }),
    takerOrder: makeOrder({ id: 'taker', isBuy: false, ...takerOverrides }),
    fillAmount,
    price,
    matchedAt:  Date.now(),
  }
}

describe('FeeEngine — broker fee (S-2-2)', () => {
  it('no broker fee when getBrokerFeeRateBps not provided', () => {
    const engine = new FeeEngine()
    const result = engine.onMatch(makeMatch({ broker: BROKER }))
    expect(result.brokerFee).toBeUndefined()
    expect(result.brokerAddr).toBeUndefined()
  })

  it('no broker fee when taker order has no broker', () => {
    const engine = new FeeEngine(undefined, () => 20)  // 20 bps configured
    const result = engine.onMatch(makeMatch())          // no broker on order
    expect(result.brokerFee).toBeUndefined()
  })

  it('no broker fee when getBrokerFeeRateBps returns 0', () => {
    const engine = new FeeEngine(undefined, () => 0)
    const result = engine.onMatch(makeMatch({ broker: BROKER }))
    expect(result.brokerFee).toBeUndefined()
  })

  it('computes brokerFee correctly — 20 bps on 1000 KRW notional = 2 KRW', () => {
    // price = 1000e18, amount = 1e18 → notional = price * amount / 1e18 = 1000e18
    // brokerFee = 1000e18 * 20 / 10000 = 2e18
    const engine = new FeeEngine(undefined, (_pairId) => 20)
    const result = engine.onMatch(makeMatch({ broker: BROKER }))

    expect(result.brokerFee).toBe(2n * 10n ** 18n)
    expect(result.brokerAddr).toBe(BROKER)
  })

  it('getBrokerFeeRateBps receives the correct pairId', () => {
    let capturedPairId = ''
    const engine = new FeeEngine(undefined, (pairId) => { capturedPairId = pairId; return 10 })
    engine.onMatch(makeMatch({ broker: BROKER }))
    expect(capturedPairId).toBe(PAIR_ID)
  })

  it('protocol makerFee and takerFee are still computed alongside brokerFee', () => {
    const engine = new FeeEngine(undefined, () => 20)
    const result = engine.onMatch(makeMatch({ broker: BROKER }))
    // takerFee = notional * takerBps / 10000. Default tier[0]: takerBps=3 → 1000e18 * 3 / 10000 = 0.3e18
    expect(result.takerFee).toBeDefined()
    expect((result.takerFee ?? 0n) > 0n).toBe(true)
    expect(result.brokerFee).toBeDefined()
  })

  it('brokerFee scales with fill amount', () => {
    const engine = new FeeEngine(undefined, () => 10)  // 10 bps
    // fillAmount = 2e18, price = 1000e18 → notional = 2000e18 → brokerFee = 2e18
    const result = engine.onMatch(makeMatch({ broker: BROKER }, 1000n * 10n ** 18n, 2n * 10n ** 18n))
    expect(result.brokerFee).toBe(2n * 10n ** 18n)
  })
})
