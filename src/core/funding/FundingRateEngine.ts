import { EventEmitter } from 'events'
import type { FundingRate, MarginPosition } from '../../types/order.js'

export interface FundingPayment {
  maker:     string
  pairId:    string
  amount:    bigint   // positive = received, negative = paid (quoteToken)
  rate:      number   // display-only human-readable rate (capped, per-period)
  timestamp: number
}

// Funding rate cap: ±4% per settlement period.
// Reference: Hyperliquid caps at ±4%/hour; dYdX v4 caps at 600%×(IMF-MMF)/8h
// (≈12~15%/8h for BTC/ETH). We settle hourly so ±4%/h is directly comparable.
//
// With positive prices, the theoretical floor is −100% (mark→0), but the cap
// keeps any single settlement within ±4% of notional, preventing runaway
// funding from thin-market manipulation.
const RATE_SCALE     = 10n ** 18n
const MAX_RATE_SCALED = 4n * RATE_SCALE / 100n   // ±4%

// Default settlement interval: 1 hour (industry standard — Hyperliquid, dYdX v4, Orderly)
const DEFAULT_INTERVAL_MS = 3600 * 1000

// Events: 'payment' (payment: FundingPayment)
export class FundingRateEngine extends EventEmitter {
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private readonly intervalMs = DEFAULT_INTERVAL_MS) {
    super()
  }

  startPair(
    pairId: string,
    getPositions:  () => MarginPosition[],
    getMarkPrice:  () => bigint,
    getIndexPrice: () => bigint,
  ): void {
    if (this.timers.has(pairId)) return
    const timer = setInterval(() => {
      void this.applyFunding(pairId, getPositions, getMarkPrice, getIndexPrice)
    }, this.intervalMs)
    this.timers.set(pairId, timer)
  }

  stopPair(pairId: string): void {
    const t = this.timers.get(pairId)
    if (t) { clearInterval(t); this.timers.delete(pairId) }
  }

  stopAll(): void {
    for (const pairId of this.timers.keys()) this.stopPair(pairId)
  }

  async applyFunding(
    pairId: string,
    getPositions:  () => MarginPosition[],
    getMarkPrice:  () => bigint,
    getIndexPrice: () => bigint,
  ): Promise<void> {
    const mark  = getMarkPrice()
    const index = getIndexPrice()
    if (index === 0n) return

    const positions = getPositions()

    for (const pos of positions) {
      if (pos.pairId !== pairId || pos.size === 0n) continue

      const absSize = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * mark / 10n ** 18n

      // Rate as fixed-point bigint scaled by RATE_SCALE (1e18)
      // rate = (mark - index) / index
      const rateScaled = (mark - index) * RATE_SCALE / index

      // Clamp to ±4% per period
      const cappedRate = rateScaled >  MAX_RATE_SCALED ?  MAX_RATE_SCALED
                       : rateScaled < -MAX_RATE_SCALED ? -MAX_RATE_SCALED
                       : rateScaled

      // Payment = notional × cappedRate / RATE_SCALE
      const rawPayment = notional * cappedRate / RATE_SCALE

      // Number() is safe here — rateNum is display-only, never used in financial math
      const MAX_RATE_NUM = 0.04   // 4%
      const rateNum = Math.max(-MAX_RATE_NUM, Math.min(MAX_RATE_NUM,
        Number(mark - index) / Number(index)))

      // Long pays when rate > 0; short receives (and vice versa)
      const amount = pos.size > 0n ? -rawPayment : rawPayment

      this.emit('payment', {
        maker: pos.maker,
        pairId,
        amount,
        rate: rateNum,
        timestamp: Date.now(),
      } satisfies FundingPayment)
    }
  }

  computeRate(markPrice: bigint, indexPrice: bigint): FundingRate {
    const rate = indexPrice > 0n ? Number(markPrice - indexPrice) / Number(indexPrice) : 0
    return { pairId: '', rate, markPrice, indexPrice, timestamp: Date.now() }
  }
}
