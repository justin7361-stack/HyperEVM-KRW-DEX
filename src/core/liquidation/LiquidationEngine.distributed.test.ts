/**
 * S-3-1: Distributed Liquidator tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiquidationEngine } from './LiquidationEngine.js'
import type { MarginPosition } from '../../types/order.js'

const SCALE = 10n ** 18n
const PAIR  = '0xAAAA/0xBBBB'

function makeOracle(price: bigint, ts = Date.now()) {
  return {
    getMarkPriceWithTs: (_pairId: string) => ({ price, ts }),
    getMarkPrice:       (_pairId: string) => price,
  } as never
}

function makePos(overrides: Partial<MarginPosition> = {}): MarginPosition {
  return {
    maker:      '0x1234000000000000000000000000000000000001',
    pairId:     PAIR,
    size:       10n * SCALE,      // 10 base tokens long
    margin:     100n * SCALE,     // 100 quote tokens margin
    mode:       'isolated',
    entryPrice: 1000n * SCALE,
    ...overrides,
  }
}

describe('LiquidationEngine — getLiquidatablePositions', () => {
  let engine: LiquidationEngine

  beforeEach(() => {
    const submitFn = vi.fn().mockResolvedValue(undefined)
    engine = new LiquidationEngine(makeOracle(1000n * SCALE), submitFn)
  })

  it('returns empty when all positions are healthy', () => {
    // size=10, markPrice=1000 → notional=10000, maintenanceMargin=250 (2.5%)
    // margin=500 >> 250 → healthy
    const pos = makePos({ margin: 500n * SCALE })
    expect(engine.getLiquidatablePositions([pos])).toHaveLength(0)
  })

  it('returns liquidatable position when margin < minMargin', () => {
    // notional = 10 * 1000 = 10000, minMargin = 10000 * 250/10000 = 250
    // margin=100 < 250 → liquidatable
    const pos = makePos({ margin: 100n * SCALE })
    const result = engine.getLiquidatablePositions([pos])
    expect(result).toHaveLength(1)
    expect(result[0].maker).toBe(pos.maker)
    expect(result[0].healthRatio).toBeLessThan(1)
    expect(result[0].minMargin).toBe(250n * SCALE)
  })

  it('includes healthRatio in result', () => {
    const pos = makePos({ margin: 125n * SCALE })  // half of minMargin=250
    const result = engine.getLiquidatablePositions([pos])
    expect(result[0].healthRatio).toBeCloseTo(0.5)
  })

  it('skips positions with size=0', () => {
    const pos = makePos({ size: 0n, margin: 1n })
    expect(engine.getLiquidatablePositions([pos])).toHaveLength(0)
  })

  it('skips positions with stale mark price', () => {
    const staleOracle = {
      getMarkPriceWithTs: () => ({ price: 1000n * SCALE, ts: Date.now() - 10 * 60 * 1000 }),
      getMarkPrice: () => 1000n * SCALE,
    } as never
    const staleEngine = new LiquidationEngine(staleOracle, vi.fn().mockResolvedValue(undefined))
    const pos = makePos({ margin: 100n * SCALE })
    expect(staleEngine.getLiquidatablePositions([pos])).toHaveLength(0)
  })

  it('handles multiple positions across pairs', () => {
    const pos1 = makePos({ margin: 100n * SCALE })
    const pos2 = makePos({ pairId: '0xCCCC/0xDDDD', margin: 50n * SCALE })
    const pos3 = makePos({ maker: '0x2222000000000000000000000000000000000002', margin: 500n * SCALE })
    const result = engine.getLiquidatablePositions([pos1, pos2, pos3])
    // pos1 and pos2 are liquidatable (same price oracle), pos3 is healthy
    expect(result).toHaveLength(2)
  })
})

describe('LiquidationEngine — triggerExternalLiquidation', () => {
  let submitFn: ReturnType<typeof vi.fn>
  let engine: LiquidationEngine

  beforeEach(() => {
    submitFn = vi.fn().mockResolvedValue(undefined)
    engine = new LiquidationEngine(makeOracle(1000n * SCALE), submitFn)
  })

  it('returns triggered=false for healthy position', async () => {
    const pos = makePos({ margin: 500n * SCALE })
    const result = await engine.triggerExternalLiquidation(pos, '0xLIQUIDATOR')
    expect(result.triggered).toBe(false)
    expect(submitFn).not.toHaveBeenCalled()
  })

  it('returns triggered=true and submits order for liquidatable position', async () => {
    const pos = makePos({ margin: 100n * SCALE })
    const result = await engine.triggerExternalLiquidation(pos, '0xLIQUIDATOR')
    expect(result.triggered).toBe(true)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('returns triggered=false for flat position', async () => {
    const pos = makePos({ size: 0n })
    const result = await engine.triggerExternalLiquidation(pos, '0xLIQUIDATOR')
    expect(result.triggered).toBe(false)
    expect(result.reason).toContain('flat')
  })

  it('emits liquidation event with liquidator in reason', async () => {
    const pos = makePos({ margin: 100n * SCALE })
    const events: string[] = []
    engine.on('liquidation', (e) => events.push(e.reason))
    await engine.triggerExternalLiquidation(pos, '0xLIQUIDATOR')
    expect(events[0]).toContain('0xLIQUIDATOR')
  })

  it('returns triggered=false when mark price is stale', async () => {
    const staleOracle = {
      getMarkPriceWithTs: () => ({ price: 1000n * SCALE, ts: Date.now() - 10 * 60 * 1000 }),
      getMarkPrice: () => 1000n * SCALE,
    } as never
    const staleEngine = new LiquidationEngine(staleOracle, submitFn)
    const pos = makePos({ margin: 100n * SCALE })
    const result = await staleEngine.triggerExternalLiquidation(pos, '0xLIQUIDATOR')
    expect(result.triggered).toBe(false)
    expect(result.reason).toContain('stale')
  })
})
