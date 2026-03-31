import { describe, it, expect, vi } from 'vitest'
import { LiquidationEngine, type LiquidationEvent } from './LiquidationEngine.js'
import { MarkPriceOracle } from '../oracle/MarkPriceOracle.js'
import type { MarginPosition, StoredOrder } from '../../types/order.js'

const PAIR = 'ETH/KRW'

function makeOracle(markPrice: bigint): MarkPriceOracle {
  const oracle = new MarkPriceOracle()
  oracle.setIndexPrice(PAIR, markPrice)
  return oracle
}

function makePosition(overrides: Partial<MarginPosition> = {}): MarginPosition {
  return {
    maker:  '0xABCD' as `0x${string}`,
    pairId: PAIR,
    size:   1n * 10n ** 18n,   // 1 ETH long
    margin: 100n,
    mode:   'isolated',
    ...overrides,
  }
}

describe('LiquidationEngine', () => {
  it('does NOT liquidate a healthy position (margin > maintenance)', async () => {
    // markPrice = 1000, notional = 1000, maintenance = 25 (2.5%)
    const oracle    = makeOracle(1000n)
    const submitFn  = vi.fn().mockResolvedValue(undefined)
    const engine    = new LiquidationEngine(oracle, submitFn)

    const liquidations: LiquidationEvent[] = []
    engine.on('liquidation', (e: LiquidationEvent) => liquidations.push(e))

    // margin=100 > maintenance=25 → healthy
    const pos = makePosition({ margin: 100n })
    await engine.checkPositions([pos])

    expect(liquidations).toHaveLength(0)
    expect(submitFn).not.toHaveBeenCalled()
  })

  it('liquidates an unhealthy long position (margin < maintenance) — emits liquidation, calls submitFn', async () => {
    // markPrice = 1000, size = 1 ETH, notional = 1000, maintenance = 25 (2.5%)
    const oracle    = makeOracle(1000n)
    const submitFn  = vi.fn().mockResolvedValue(undefined)
    const engine    = new LiquidationEngine(oracle, submitFn)

    const liquidations: LiquidationEvent[] = []
    engine.on('liquidation', (e: LiquidationEvent) => liquidations.push(e))

    // margin=10 < maintenance=25 → unhealthy
    const pos = makePosition({ margin: 10n })
    await engine.checkPositions([pos])

    expect(liquidations).toHaveLength(1)
    expect(liquidations[0].position).toEqual(pos)
    expect(liquidations[0].markPrice).toBe(1000n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('liquidation order: long → sell (isBuy=false), short → buy (isBuy=true)', async () => {
    const oracle = makeOracle(1000n)

    const submittedOrders: StoredOrder[] = []
    const submitFn = vi.fn().mockImplementation(async (order: StoredOrder) => {
      submittedOrders.push(order)
    })
    const engine = new LiquidationEngine(oracle, submitFn)

    // Unhealthy long (size > 0) → liquidation order should be sell (isBuy=false)
    const longPos  = makePosition({ size:  1n * 10n ** 18n, margin: 1n })
    // Unhealthy short (size < 0) → liquidation order should be buy (isBuy=true)
    const shortPos = makePosition({ size: -(1n * 10n ** 18n), margin: 1n })

    await engine.checkPositions([longPos, shortPos])

    expect(submittedOrders).toHaveLength(2)
    expect(submittedOrders[0].isBuy).toBe(false)   // close long → sell
    expect(submittedOrders[1].isBuy).toBe(true)    // close short → buy
    expect(submittedOrders[0].orderType).toBe('market')
    expect(submittedOrders[1].orderType).toBe('market')
    // amount = 20% of position size
    expect(submittedOrders[0].amount).toBe(1n * 10n ** 18n * 20n / 100n)
    expect(submittedOrders[1].amount).toBe(1n * 10n ** 18n * 20n / 100n)
  })

  it('skips positions with size=0n or markPrice=0n', async () => {
    const oracleZero = makeOracle(0n)  // markPrice = 0
    const submitFn   = vi.fn().mockResolvedValue(undefined)
    const engine     = new LiquidationEngine(oracleZero, submitFn)

    const liquidations: LiquidationEvent[] = []
    engine.on('liquidation', (e: LiquidationEvent) => liquidations.push(e))

    const zeroSize = makePosition({ size: 0n, margin: 0n })
    const zeroMark = makePosition({ size: 1n * 10n ** 18n, margin: 1n })  // markPrice=0 from oracle

    await engine.checkPositions([zeroSize, zeroMark])

    expect(liquidations).toHaveLength(0)
    expect(submitFn).not.toHaveBeenCalled()
  })

  it('partial liquidation — 20% per step, 5 steps then auto-cleanup resets counter', async () => {
    const oracle = makeOracle(1000n)
    const submitFn = vi.fn().mockResolvedValue(undefined)
    const engine = new LiquidationEngine(oracle, submitFn)

    const liquidations: LiquidationEvent[] = []
    engine.on('liquidation', (e: LiquidationEvent) => liquidations.push(e))

    const pos = makePosition({ size: 1n * 10n ** 18n, margin: 1n })

    // Call 5 times — exactly fills the 5-step cycle; Map entry is auto-cleaned after step 5
    for (let i = 0; i < 5; i++) {
      await engine.checkPositions([pos])
    }

    expect(submitFn).toHaveBeenCalledTimes(5)
    expect(liquidations).toHaveLength(5)

    // Each order amount = 20% of 1 ETH
    const calls = submitFn.mock.calls
    for (const call of calls) {
      const order = call[0] as StoredOrder
      expect(order.amount).toBe(1n * 10n ** 18n * 20n / 100n)
    }
  })

  it('tiny position fallback — amount = full absSize when 20% truncates to 0', async () => {
    // absSize = 4n → 4n * 20n / 100n = 0n → fallback to full 4n
    // markPrice must be large enough so notional > 0 and margin check fails:
    // notional = 4n * (1000n * 10n**18n) / 10n**18n = 4000n, minMargin = 100n
    const oracle = makeOracle(1000n * 10n ** 18n)
    const submittedOrders: StoredOrder[] = []
    const submitFn = vi.fn().mockImplementation(async (order: StoredOrder) => {
      submittedOrders.push(order)
    })
    const engine = new LiquidationEngine(oracle, submitFn)

    // size = 4n (tiny), margin = 0n (definitely under-margined)
    const pos = makePosition({ size: 4n, margin: 0n })
    await engine.checkPositions([pos])

    expect(submittedOrders).toHaveLength(1)
    expect(submittedOrders[0].amount).toBe(4n)  // full fallback, not 0n
  })

  it('resetSteps — resets liquidation step counter', async () => {
    const oracle = makeOracle(1000n)
    const submitFn = vi.fn().mockResolvedValue(undefined)
    const engine = new LiquidationEngine(oracle, submitFn)

    const pos = makePosition({ size: 1n * 10n ** 18n, margin: 1n })

    // Do 2 partial liquidations
    await engine.checkPositions([pos])
    await engine.checkPositions([pos])

    expect(submitFn).toHaveBeenCalledTimes(2)

    // Reset step counter
    engine.resetSteps(pos.maker, pos.pairId)

    // Do 5 more — should all go through now
    for (let i = 0; i < 5; i++) {
      await engine.checkPositions([pos])
    }

    expect(submitFn).toHaveBeenCalledTimes(7)
  })
})
