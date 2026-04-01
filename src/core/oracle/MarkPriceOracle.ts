import type { TradeRecord } from '../../types/order.js'

// 3-component Mark Price (Orderly Network approach):
//   P1  = indexPrice × (1 + lastFundingRate × timeToNextFunding)
//   P2  = indexPrice + 15-min MA(markPrice − indexPrice)
//   mid = (bestBid + bestAsk) / 2
//   markPrice = median(P1, P2, mid)
export class MarkPriceOracle {
  private readonly prices        = new Map<string, { price: bigint; ts: number }[]>()
  private readonly indexPrices   = new Map<string, bigint>()
  private readonly spreadHistory = new Map<string, Array<{ spread: bigint; ts: number }>>()

  private readonly FUNDING_INTERVAL_MS = 8 * 3600 * 1000   // 8 hours in ms
  private readonly SPREAD_WINDOW_MS    = 15 * 60 * 1000    // 15 minutes in ms
  private readonly RATE_SCALE          = 10n ** 18n

  // Optional injected getters — set after construction to avoid circular deps
  private getFundingRate?: (pairId: string) => { rateScaled: bigint; timestamp: number } | null
  private getMidPrice?:    (pairId: string) => bigint | null

  constructor(private readonly windowMs = 5 * 60_000) {}

  setFundingRateGetter(fn: (pairId: string) => { rateScaled: bigint; timestamp: number } | null): void {
    this.getFundingRate = fn
  }

  setMidPriceGetter(fn: (pairId: string) => bigint | null): void {
    this.getMidPrice = fn
  }

  onTrade(pairId: string, trade: Pick<TradeRecord, 'price' | 'tradedAt'>): void {
    // TWAP price recording
    const list   = this.prices.get(pairId) ?? []
    list.push({ price: trade.price, ts: trade.tradedAt })
    const cutoff = trade.tradedAt - this.windowMs
    this.prices.set(pairId, list.filter(t => t.ts >= cutoff))

    // Record spread for P2 MA computation
    const indexPrice = this.indexPrices.get(pairId)
    if (indexPrice && indexPrice > 0n) {
      const spread  = trade.price - indexPrice
      const history = this.spreadHistory.get(pairId) ?? []
      history.push({ spread, ts: trade.tradedAt })
      // Prune entries older than 15 minutes
      const spreadCutoff = trade.tradedAt - this.SPREAD_WINDOW_MS
      this.spreadHistory.set(pairId, history.filter(h => h.ts >= spreadCutoff))
    }
  }

  setIndexPrice(pairId: string, price: bigint): void {
    this.indexPrices.set(pairId, price)
  }

  getMarkPrice(pairId: string): bigint {
    const indexPrice = this.indexPrices.get(pairId) ?? 0n
    if (indexPrice === 0n) return this.getTwap(pairId)  // fallback to TWAP

    // P1: index × (1 + fundingRate × timeToNextFunding)
    const p1 = this._computeP1(pairId, indexPrice)

    // P2: index + 15-min MA(mark − index)
    const p2 = this._computeP2(pairId, indexPrice)

    // midPrice: (bestBid + bestAsk) / 2
    const mid = this.getMidPrice?.(pairId) ?? this.getTwap(pairId)

    return this._median(p1, p2, mid)
  }

  private _computeP1(pairId: string, indexPrice: bigint): bigint {
    if (!this.getFundingRate) return indexPrice
    const fr = this.getFundingRate(pairId)
    if (!fr) return indexPrice

    const now                = Date.now()
    const msSinceLastFunding = now - fr.timestamp
    const msToNextFunding    = this.FUNDING_INTERVAL_MS - (msSinceLastFunding % this.FUNDING_INTERVAL_MS)
    // timeToNextFunding as fraction of funding interval (0..1), scaled
    const timeScaled = BigInt(msToNextFunding) * this.RATE_SCALE / BigInt(this.FUNDING_INTERVAL_MS)
    const rateScaled = fr.rateScaled
    // P1 = indexPrice × (1 + rate × timeToNext) = indexPrice + indexPrice × rate × timeToNext / RATE_SCALE²
    // Multiply all numerators before dividing to avoid compounding integer truncation
    const premium = indexPrice * rateScaled * timeScaled / (this.RATE_SCALE * this.RATE_SCALE)
    return indexPrice + premium
  }

  private _computeP2(pairId: string, indexPrice: bigint): bigint {
    const history = this.spreadHistory.get(pairId)
    if (!history || history.length === 0) return indexPrice
    const cutoff = Date.now() - this.SPREAD_WINDOW_MS
    const recent = history.filter(h => h.ts >= cutoff)
    if (recent.length === 0) return indexPrice
    // MA = sum(spreads) / count
    const sum = recent.reduce((acc, h) => acc + h.spread, 0n)
    const ma  = sum / BigInt(recent.length)
    return indexPrice + ma
  }

  private _median(a: bigint, b: bigint, c: bigint): bigint {
    const sorted = [a, b, c].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
    return sorted[1]
  }

  private getTwap(pairId: string): bigint {
    const list = this.prices.get(pairId)
    if (!list || list.length === 0) return 0n
    const sum = list.reduce((acc, t) => acc + t.price, 0n)
    return sum / BigInt(list.length)
  }

  getIndexPrice(pairId: string): bigint {
    return this.indexPrices.get(pairId) ?? this.getMarkPrice(pairId)
  }
}
