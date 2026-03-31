import { describe, it, expect, beforeEach } from 'vitest'
import { FeeEngine } from './FeeEngine.js'
import type { MatchResult, StoredOrder } from '../../types/order.js'

const MAKER = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TAKER = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function storedOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'o1',
    maker: MAKER as any,
    taker: TAKER as any,
    baseToken: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any,
    quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any,
    price: 0n,
    amount: 0n,
    isBuy: false,
    nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any,
    submittedAt: Date.now(),
    filledAmount: 0n,
    status: 'open',
    makerIp: '127.0.0.1',
    ...overrides,
  }
}

function makeMatch(
  price: bigint,
  fillAmount: bigint,
  matchedAt: number,
  makerOverrides: Partial<StoredOrder> = {},
  takerOverrides: Partial<StoredOrder> = {},
): MatchResult {
  return {
    makerOrder: storedOrder({ id: 'maker-order', ...makerOverrides }),
    takerOrder: storedOrder({ id: 'taker-order', maker: TAKER as any, ...takerOverrides }),
    fillAmount,
    price,
    matchedAt,
  }
}

// Custom tiers with very large thresholds so fee-math tests can use 18-decimal amounts
// without accidentally crossing tier boundaries
const HIGH_THRESHOLD_TIERS = [
  { minVolume30d: 0n,                    makerBps: 1,  takerBps: 3 },
  { minVolume30d: 10n ** 27n,            makerBps: 0,  takerBps: 2 },  // 1 billion tokens (18 dec)
  { minVolume30d: 10n * 10n ** 27n,      makerBps: -1, takerBps: 1 },  // 10 billion tokens (18 dec)
]

describe('FeeEngine', () => {
  let engine: FeeEngine
  const NOW = Date.now()

  beforeEach(() => {
    engine = new FeeEngine()
  })

  // ── Tier selection (using default tiers where thresholds are raw units) ──────

  it('new user (0 volume) → Tier 0 (makerBps=1, takerBps=3)', () => {
    const tier = engine.getTier(MAKER)
    expect(tier.makerBps).toBe(1)
    expect(tier.takerBps).toBe(3)
  })

  it('user with 1M+ volume → Tier 1 (makerBps=0, takerBps=2)', () => {
    // Use fillAmount = 1_000_000n (raw units, not 18-decimal) so it lands exactly at Tier 1
    engine.onMatch(makeMatch(1n, 1_000_000n, NOW))
    const tier = engine.getTier(MAKER.toLowerCase())
    expect(tier.makerBps).toBe(0)
    expect(tier.takerBps).toBe(2)
  })

  it('user with 10M+ volume → Tier 2 (makerBps=-1, takerBps=1)', () => {
    // fillAmount = 10_000_000n lands at Tier 2
    engine.onMatch(makeMatch(1n, 10_000_000n, NOW))
    const tier = engine.getTier(MAKER.toLowerCase())
    expect(tier.makerBps).toBe(-1)
    expect(tier.takerBps).toBe(1)
  })

  // ── Fee math (use high-threshold tiers so 18-decimal amounts stay in Tier 0) ─

  it('onMatch() sets makerFee and takerFee correctly for Tier 0', () => {
    const feEngine = new FeeEngine(HIGH_THRESHOLD_TIERS)
    const price = 2n * 10n ** 18n        // 2.0 in 18-decimal fixed-point
    const fillAmount = 3n * 10n ** 18n   // 3.0 base tokens
    // quoteAmount = price * fillAmount / 1e18 = 2e18 * 3e18 / 1e18 = 6e18
    const quoteAmount = price * fillAmount / 10n ** 18n
    // makerFee Tier0: quoteAmount * 1 / 10000
    const expectedMakerFee = quoteAmount * 1n / 10000n
    // takerFee Tier0: quoteAmount * 3 / 10000
    const expectedTakerFee = quoteAmount * 3n / 10000n

    const result = feEngine.onMatch(makeMatch(price, fillAmount, NOW))

    expect(result.makerFee).toBe(expectedMakerFee)
    expect(result.takerFee).toBe(expectedTakerFee)
  })

  it('onMatch() returns 0n makerFee for Tier 1 (zero-fee tier)', () => {
    // Pre-load maker to Tier 1 using raw-unit fillAmount (default tiers)
    engine.onMatch(makeMatch(1n, 1_000_000n, NOW - 1000))

    // Small trade using raw units that won't push maker to Tier 2
    const price = 2n * 10n ** 18n
    const fillAmount = 1n
    const result = engine.onMatch(makeMatch(price, fillAmount, NOW))

    // Tier 1 makerBps = 0 → makerFee must be 0n
    expect(result.makerFee).toBe(0n)
    // takerFee: Tier 1 takerBps=2, but quoteAmount = 2e18 * 1 / 1e18 = 2
    const quoteAmount = price * fillAmount / 10n ** 18n
    expect(result.takerFee).toBe(quoteAmount * 2n / 10000n)
  })

  it('onMatch() returns negative makerFee (rebate) for Tier 2', () => {
    // Pre-load maker to Tier 2 using raw-unit fillAmount
    engine.onMatch(makeMatch(1n, 10_000_000n, NOW - 1000))

    // Small trade using raw units that keeps maker in Tier 2
    const price = 2n * 10n ** 18n
    const fillAmount = 1n
    const result = engine.onMatch(makeMatch(price, fillAmount, NOW))

    // Tier 2 makerBps = -1 → makerFee must be negative
    const quoteAmount = price * fillAmount / 10n ** 18n
    const expectedRebate = -(quoteAmount * 1n / 10000n)
    expect(result.makerFee).toBe(expectedRebate)
    // takerFee Tier 2: takerBps=1
    expect(result.takerFee).toBe(quoteAmount * 1n / 10000n)
  })

  // ── Taker volume tracking ───────────────────────────────────────────────────

  it('taker with 10M+ volume qualifies for Tier 2', () => {
    const TAKER_ADDRESS = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC'
    // Use a fill of 10_000_000n raw units so the taker crosses the Tier 2 threshold
    engine.onMatch(makeMatch(1n, 10_000_000n, NOW, {}, { maker: TAKER_ADDRESS as any }))
    const tier = engine.getTier(TAKER_ADDRESS)
    expect(tier.makerBps).toBe(-1)
    expect(tier.takerBps).toBe(1)
  })

  // ── Rolling window eviction ─────────────────────────────────────────────────

  it('volume older than 30 days gets evicted, user drops back to Tier 0', () => {
    const thirtyOneDaysAgo = NOW - (31 * 24 * 3600 * 1000)

    // Record a Tier 2-level trade that is 31 days old
    engine.onMatch(makeMatch(1n, 10_000_000n, thirtyOneDaysAgo))

    // Confirm maker is at Tier 2 before eviction
    expect(engine.getTier(MAKER.toLowerCase()).makerBps).toBe(-1)

    // Now trigger a new trade at current time — the old trade gets evicted
    engine.onMatch(makeMatch(1n, 1n, NOW))

    // After eviction of the 31-day-old trade, volume drops to ~1n → Tier 0
    const tier = engine.getTier(MAKER.toLowerCase())
    expect(tier.makerBps).toBe(1)
    expect(tier.takerBps).toBe(3)
  })
})
