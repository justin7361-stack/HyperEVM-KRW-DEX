import { EventEmitter } from 'events'
import type { FundingRate, MarginPosition } from '../../types/order.js'

export interface FundingPayment {
  maker:     string
  pairId:    string
  amount:    bigint   // positive = received, negative = paid (quoteToken)
  rate:      number
  timestamp: number
}

// Events: 'payment' (payment: FundingPayment)
export class FundingRateEngine extends EventEmitter {
  private timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(private readonly intervalMs = 8 * 3600 * 1000) {
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

    const RATE_SCALE = 10n ** 18n
    // Cap rate at ±600%. Negative cap (-600%) is a safety net only —
    // with positive prices, rate = (mark-index)/index ≥ -100% always.
    const MAX_RATE_SCALED = 6n * RATE_SCALE

    const positions = getPositions()

    for (const pos of positions) {
      if (pos.pairId !== pairId || pos.size === 0n) continue
      const absSize = pos.size < 0n ? -pos.size : pos.size
      const notional = absSize * mark / 10n ** 18n
      // Rate as fixed-point bigint (scaled by 1e18)
      const rateScaled = (mark - index) * RATE_SCALE / index
      const cappedRate = rateScaled > MAX_RATE_SCALED ? MAX_RATE_SCALED
                       : rateScaled < -MAX_RATE_SCALED ? -MAX_RATE_SCALED
                       : rateScaled
      // Payment = notional * cappedRate / RATE_SCALE
      const rawPayment = notional * cappedRate / RATE_SCALE
      // Keep rate as number only for the FundingPayment.rate field (human-readable)
      const MAX_RATE_NUM = 6.0
      // Number() is safe here — rateNum is display-only, not used in financial math
      const rateNum = Math.max(-MAX_RATE_NUM, Math.min(MAX_RATE_NUM, Number(mark - index) / Number(index)))
      // Long pays when rate > 0; short receives (and vice versa)
      const amount = pos.size > 0n ? -rawPayment : rawPayment
      this.emit('payment', { maker: pos.maker, pairId, amount, rate: rateNum, timestamp: Date.now() } satisfies FundingPayment)
    }
  }

  computeRate(markPrice: bigint, indexPrice: bigint): FundingRate {
    const rate = indexPrice > 0n ? Number(markPrice - indexPrice) / Number(indexPrice) : 0
    return { pairId: '', rate, markPrice, indexPrice, timestamp: Date.now() }
  }
}
