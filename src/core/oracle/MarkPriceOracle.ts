import type { TradeRecord } from '../../types/order.js'

// Simple TWAP-based mark price using last `windowMs` of trades (default: 5 minutes).
// External oracle feed can override via setIndexPrice().
export class MarkPriceOracle {
  private readonly trades  = new Map<string, { price: bigint; ts: number }[]>()
  private readonly indexes = new Map<string, bigint>()

  constructor(private readonly windowMs = 5 * 60_000) {}

  onTrade(pairId: string, trade: TradeRecord): void {
    const list   = this.trades.get(pairId) ?? []
    list.push({ price: trade.price, ts: trade.tradedAt })
    const cutoff = trade.tradedAt - this.windowMs
    this.trades.set(pairId, list.filter(t => t.ts >= cutoff))
  }

  setIndexPrice(pairId: string, price: bigint): void {
    this.indexes.set(pairId, price)
  }

  getMarkPrice(pairId: string): bigint {
    const list = this.trades.get(pairId) ?? []
    if (list.length === 0) return this.indexes.get(pairId) ?? 0n
    const sum = list.reduce((acc, t) => acc + t.price, 0n)
    return sum / BigInt(list.length)
  }

  getIndexPrice(pairId: string): bigint {
    return this.indexes.get(pairId) ?? this.getMarkPrice(pairId)
  }
}
