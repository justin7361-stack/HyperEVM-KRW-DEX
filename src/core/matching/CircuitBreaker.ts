import { EventEmitter } from 'events'

export interface HaltInfo {
  pairId:   string
  reason:   string
  haltedAt: number
}

interface PriceEntry {
  price: bigint
  ts:    number
}

/**
 * CircuitBreaker — halts trading when:
 *   (a) mark price moves more than priceBandPct in windowMs
 *   (b) admin manually triggers halt
 *
 * Usage:
 *   const cb = new CircuitBreaker({ priceBandPct: 10, windowMs: 60_000 })
 *   cb.recordPrice(pairId, markPrice)   // called on each mark price update
 *   cb.isHalted(pairId)                 // called before accepting orders
 *   cb.halt(pairId, reason)             // admin manual halt
 *   cb.resume(pairId)                   // admin manual resume
 *
 * Events:
 *   'halted'  → { pairId, reason, haltedAt }
 *   'resumed' → { pairId, resumedAt }
 */
export class CircuitBreaker extends EventEmitter {
  private readonly priceBandPct: number
  private readonly windowMs:     number

  // Rolling window of price observations per pairId
  private readonly priceWindows = new Map<string, PriceEntry[]>()
  // Currently halted pairs
  private readonly haltedPairs  = new Map<string, HaltInfo>()

  constructor(cfg: { priceBandPct: number; windowMs: number }) {
    super()
    this.priceBandPct = cfg.priceBandPct
    this.windowMs     = cfg.windowMs
  }

  /**
   * Record a new mark price observation. Auto-trips if band exceeded.
   * All math in bigint; pctChange converted to Number only for display/comparison.
   */
  recordPrice(pairId: string, price: bigint): void {
    // If already halted, still record but skip auto-trip check
    const now    = Date.now()
    const cutoff = now - this.windowMs

    const window = this.priceWindows.get(pairId) ?? []
    // Purge stale entries
    const fresh = window.filter(e => e.ts >= cutoff)
    fresh.push({ price, ts: now })
    this.priceWindows.set(pairId, fresh)

    // Only auto-trip if not already halted
    if (this.haltedPairs.has(pairId)) return

    if (fresh.length >= 2) {
      const oldest = fresh[0]
      // pctChange = abs(newPrice - oldestPrice) / oldestPrice * 100
      // Use bigint arithmetic: multiply by 10_000 for 2 decimal precision, then convert
      const diff        = price > oldest.price ? price - oldest.price : oldest.price - price
      // Scale by 10_000 before dividing to retain 2 decimal places of precision
      const pctScaled   = diff * 10_000n / oldest.price   // in units of 0.01%
      const pctChange   = Number(pctScaled) / 100          // e.g. 1000 → 10.00

      if (pctChange > this.priceBandPct) {
        this.halt(pairId, `auto: price moved ${pctChange.toFixed(2)}% in ${this.windowMs}ms`)
      }
    }
  }

  /** Returns true if trading is halted for this pair. */
  isHalted(pairId: string): boolean {
    return this.haltedPairs.has(pairId)
  }

  /** Manual (or auto) halt. Emits 'halted' event. Idempotent — no-op if already halted. */
  halt(pairId: string, reason: string): void {
    if (this.haltedPairs.has(pairId)) return
    const haltedAt = Date.now()
    const info: HaltInfo = { pairId, reason, haltedAt }
    this.haltedPairs.set(pairId, info)
    this.emit('halted', info)
  }

  /** Resume trading. Emits 'resumed' event. No-op if not halted. */
  resume(pairId: string): void {
    if (!this.haltedPairs.has(pairId)) return
    this.haltedPairs.delete(pairId)
    this.emit('resumed', { pairId, resumedAt: Date.now() })
  }

  /** Returns status of all halted pairs. */
  getHaltedPairs(): HaltInfo[] {
    return [...this.haltedPairs.values()]
  }
}
