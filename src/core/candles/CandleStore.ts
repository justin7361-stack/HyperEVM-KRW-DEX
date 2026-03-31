import type { Candle, CandleResolution, TradeRecord } from '../../types/order.js'

const RESOLUTION_MS: Record<CandleResolution, number> = {
  '1m':  60_000,
  '5m':  300_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
}

export class CandleStore {
  // key: `${pairId}:${resolution}:${openTime}`
  private readonly candles = new Map<string, Candle>()

  onTrade(pairId: string, trade: TradeRecord): void {
    for (const res of Object.keys(RESOLUTION_MS) as CandleResolution[]) {
      this.update(pairId, res, trade)
    }
  }

  private update(pairId: string, resolution: CandleResolution, trade: TradeRecord): void {
    const ms       = RESOLUTION_MS[resolution]
    const openTime = Math.floor(trade.tradedAt / ms) * ms
    const k        = `${pairId}:${resolution}:${openTime}`

    const existing = this.candles.get(k)
    if (!existing) {
      this.candles.set(k, {
        pairId, resolution, openTime,
        open: trade.price, high: trade.price, low: trade.price, close: trade.price,
        volume: trade.amount, tradeCount: 1,
      })
    } else {
      existing.high       = trade.price > existing.high ? trade.price : existing.high
      existing.low        = trade.price < existing.low  ? trade.price : existing.low
      existing.close      = trade.price
      existing.volume    += trade.amount
      existing.tradeCount++
    }
  }

  get(pairId: string, resolution: CandleResolution, start: number, end: number): Candle[] {
    const results: Candle[] = []
    for (const candle of this.candles.values()) {
      if (candle.pairId === pairId && candle.resolution === resolution &&
          candle.openTime >= start && candle.openTime < end) {
        results.push({ ...candle })
      }
    }
    return results.sort((a, b) => a.openTime - b.openTime)
  }
}
