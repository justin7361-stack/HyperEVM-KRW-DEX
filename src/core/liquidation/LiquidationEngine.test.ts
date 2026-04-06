import { describe, it, expect, vi } from 'vitest'
import { LiquidationEngine, type LiquidationEvent, type ADLCandidate } from './LiquidationEngine.js'
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
    maker:      '0xABCD' as `0x${string}`,
    pairId:     PAIR,
    size:       1n * 10n ** 18n,   // 1 ETH long
    margin:     100n,
    mode:       'isolated',
    entryPrice: 0n,
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

  it('connects to InsuranceFund — covers estimated loss on liquidation', async () => {
    const oracle = makeOracle(1000n)
    const submitFn = vi.fn().mockResolvedValue(undefined)

    // Import InsuranceFund dynamically or inline a mock
    // Use a simple mock object that matches the IInsuranceFund interface
    const coverCalls: Array<{ pairId: string; loss: bigint }> = []
    const mockFund = {
      cover(pairId: string, loss: bigint): boolean {
        coverCalls.push({ pairId, loss })
        return true
      },
      deposit(_pairId: string, _amount: bigint): void {},
      getBalance(_pairId: string): bigint { return 0n },
    }

    const engine = new LiquidationEngine(oracle, submitFn, 250n, mockFund)

    // margin=10, minMargin=25 → estimatedLoss = 25-10 = 15
    const pos = makePosition({ margin: 10n })
    await engine.checkPositions([pos])

    expect(coverCalls).toHaveLength(1)
    expect(coverCalls[0].pairId).toBe(PAIR)
    expect(coverCalls[0].loss).toBe(15n)  // minMargin(25) - margin(10) = 15
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

// ── selectADLTargets ──────────────────────────────────────────────────────────

describe('LiquidationEngine.selectADLTargets (G-4)', () => {
  const MARK = 1000n * 10n ** 18n   // 1 ETH = 1000 KRW
  const QUOTE = '0xKRW' as `0x${string}`

  function engine() {
    const oracle = makeOracle(MARK)
    return new LiquidationEngine(oracle, vi.fn())
  }

  function makePos(overrides: Partial<MarginPosition> = {}): MarginPosition {
    return {
      maker:      '0xAABB' as `0x${string}`,
      pairId:     PAIR,
      size:       1n * 10n ** 18n,
      margin:     100n * 10n ** 18n,
      mode:       'isolated',
      entryPrice: 0n,
      ...overrides,
    }
  }

  it('returns empty when no opposite-side positions exist', () => {
    const eng = engine()
    // All positions are LONG; loser is also long → no SHORT candidates
    const positions = [
      makePos({ maker: '0xA1' as `0x${string}`, size:  1n * 10n ** 18n }),
      makePos({ maker: '0xA2' as `0x${string}`, size:  2n * 10n ** 18n }),
    ]
    const result = eng.selectADLTargets(positions, PAIR, QUOTE, 'long', 500n, MARK)
    expect(result).toHaveLength(0)
  })

  it('returns empty when totalLoss is 0', () => {
    const eng = engine()
    const positions = [makePos({ size: -(1n * 10n ** 18n) })]
    const result = eng.selectADLTargets(positions, PAIR, QUOTE, 'long', 0n, MARK)
    expect(result).toHaveLength(0)
  })

  it('returns empty when markPrice is 0', () => {
    const eng = engine()
    const positions = [makePos({ size: -(1n * 10n ** 18n) })]
    const result = eng.selectADLTargets(positions, PAIR, QUOTE, 'long', 500n, 0n)
    expect(result).toHaveLength(0)
  })

  it('selects SHORT candidates when loser is LONG', () => {
    const eng = engine()
    const positions = [
      makePos({ maker: '0xLONG'  as `0x${string}`, size:  1n * 10n ** 18n }),   // long — skipped
      makePos({ maker: '0xSHORT' as `0x${string}`, size: -(1n * 10n ** 18n) }),  // short — selected
    ]
    const result = eng.selectADLTargets(positions, PAIR, QUOTE, 'long', 50n * 10n ** 18n, MARK)
    expect(result).toHaveLength(1)
    expect(result[0].maker).toBe('0xSHORT')
  })

  it('selects LONG candidates when loser is SHORT', () => {
    const eng = engine()
    const positions = [
      makePos({ maker: '0xSHORT' as `0x${string}`, size: -(1n * 10n ** 18n) }),  // short — skipped
      makePos({ maker: '0xLONG'  as `0x${string}`, size:  1n * 10n ** 18n }),    // long — selected
    ]
    const result = eng.selectADLTargets(positions, PAIR, QUOTE, 'short', 50n * 10n ** 18n, MARK)
    expect(result).toHaveLength(1)
    expect(result[0].maker).toBe('0xLONG')
  })

  it('ranks by effective leverage — highest leverage first', () => {
    const eng = engine()
    // Size: both 1 ETH short; margins differ
    // Lower margin → higher leverage → selected first
    const highLevPos = makePos({
      maker:  '0xHIGH' as `0x${string}`,
      size:   -(1n * 10n ** 18n),
      margin: 50n * 10n ** 18n,   // leverage ≈ 20x
    })
    const lowLevPos = makePos({
      maker:  '0xLOW' as `0x${string}`,
      size:   -(1n * 10n ** 18n),
      margin: 200n * 10n ** 18n,  // leverage ≈ 5x
    })
    // totalLoss must exceed highLevPos.margin (50e18) so both candidates are needed
    const result = eng.selectADLTargets([lowLevPos, highLevPos], PAIR, QUOTE, 'long', 100n * 10n ** 18n, MARK)
    // Highest leverage first
    expect(result[0].maker).toBe('0xHIGH')
    expect(result[1].maker).toBe('0xLOW')
  })

  it('accumulates candidates until totalLoss is covered', () => {
    const eng = engine()
    const pos1 = makePos({ maker: '0xP1' as `0x${string}`, size: -(1n * 10n ** 18n), margin: 30n * 10n ** 18n })
    const pos2 = makePos({ maker: '0xP2' as `0x${string}`, size: -(1n * 10n ** 18n), margin: 30n * 10n ** 18n })
    const pos3 = makePos({ maker: '0xP3' as `0x${string}`, size: -(1n * 10n ** 18n), margin: 30n * 10n ** 18n })

    // totalLoss = 50e18; each pos has 30e18 margin
    // Should select pos1 (30e18) + pos2 (20e18 remaining) = 2 candidates
    const totalLoss = 50n * 10n ** 18n
    const result = eng.selectADLTargets([pos1, pos2, pos3], PAIR, QUOTE, 'long', totalLoss, MARK)

    expect(result).toHaveLength(2)
    const totalAmount = result.reduce((sum, c) => sum + c.amount, 0n)
    expect(totalAmount).toBe(totalLoss)
  })

  it('each candidate amount is capped at their margin', () => {
    const eng = engine()
    const pos = makePos({
      maker:  '0xBIG' as `0x${string}`,
      size:   -(1n * 10n ** 18n),
      margin: 10n * 10n ** 18n,  // only 10 available
    })
    // totalLoss = 999 >> margin
    const result = eng.selectADLTargets([pos], PAIR, QUOTE, 'long', 999n * 10n ** 18n, MARK)
    expect(result).toHaveLength(1)
    expect(result[0].amount).toBe(10n * 10n ** 18n)  // capped at margin
  })

  it('skips positions with zero size', () => {
    const eng = engine()
    const zeroPos = makePos({ size: 0n, maker: '0xZERO' as `0x${string}` })
    const validPos = makePos({ size: -(1n * 10n ** 18n), maker: '0xVALID' as `0x${string}` })
    const result = eng.selectADLTargets([zeroPos, validPos], PAIR, QUOTE, 'long', 10n * 10n ** 18n, MARK)
    expect(result).toHaveLength(1)
    expect(result[0].maker).toBe('0xVALID')
  })

  it('skips positions from a different pairId', () => {
    const eng = engine()
    const wrongPair = makePos({ pairId: 'BTC/KRW', size: -(1n * 10n ** 18n) })
    const rightPair = makePos({ pairId: PAIR,      size: -(1n * 10n ** 18n), maker: '0xRIGHT' as `0x${string}` })
    const result = eng.selectADLTargets([wrongPair, rightPair], PAIR, QUOTE, 'long', 10n * 10n ** 18n, MARK)
    expect(result).toHaveLength(1)
    expect(result[0].maker).toBe('0xRIGHT')
  })
})
