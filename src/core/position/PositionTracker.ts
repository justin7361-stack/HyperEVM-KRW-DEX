import { EventEmitter } from 'events'
import type { MatchResult, MarginMode, MarginPosition } from '../../types/order.js'
import type { Address } from 'viem'

// 1e18 scaling factor — all price/amount values are 18-decimal scaled
const SCALE = 10n ** 18n

/** Internal state per (maker, pairId) position. */
interface PositionState {
  size:       bigint     // positive = long, negative = short
  margin:     bigint     // estimated margin backing this position (scaled by 1e18)
  mode:       MarginMode
  entryPrice: bigint     // weighted-average entry price (18-decimal, quote per base)
}

/**
 * Tracks net base-token positions and estimated margins per (maker, pairId).
 *
 * Fixes:
 *  CR-1 — getAll() was returning margin=0n for every position, making all positions
 *          immediately eligible for liquidation. Now computes margin from fill price + leverage.
 *  CR-2 — onMatch() was only updating the maker side. Now updates both maker and taker.
 */
export class PositionTracker extends EventEmitter {
  private readonly pos = new Map<string, PositionState>()

  constructor() {
    super()
  }

  private key(maker: string, pairId: string): string {
    return `${maker.toLowerCase()}:${pairId}`
  }

  onMatch(pairId: string, match: MatchResult): void {
    // Notional value of the fill in quote-token units (18-decimal).
    // price=0n means market order — fall back to fillAmount as notional approximation.
    const notional = match.price > 0n
      ? (match.fillAmount * match.price) / SCALE
      : match.fillAmount

    // ── Maker side ──────────────────────────────────────────────────────────
    const makerLeverage = match.makerOrder.leverage ?? 1n
    const makerMode     = match.makerOrder.marginMode ?? 'cross'
    const makerDelta    = match.makerOrder.isBuy ? match.fillAmount : -match.fillAmount
    const makerMargin   = this._calcMarginDelta(notional, makerLeverage)

    this._update(match.makerOrder.maker, pairId, makerDelta, makerMargin, makerMode, match.price)

    // ── Taker side (CR-2: was completely absent) ─────────────────────────
    // Taker direction is always opposite to maker.
    const takerLeverage = match.takerOrder.leverage ?? 1n
    const takerMode     = match.takerOrder.marginMode ?? 'cross'
    const takerDelta    = -makerDelta   // opposite sign
    const takerMargin   = this._calcMarginDelta(notional, takerLeverage)

    this._update(match.takerOrder.maker, pairId, takerDelta, takerMargin, takerMode, match.price)
  }

  /**
   * Compute margin contribution from a fill.
   * margin = notional / leverage, minimum 1n to ensure non-zero.
   */
  private _calcMarginDelta(notional: bigint, leverage: bigint): bigint {
    if (leverage <= 0n) leverage = 1n
    const m = notional / leverage
    return m > 0n ? m : 1n
  }

  /**
   * Update position state for one side of a match.
   *
   * Margin accounting:
   *  • Position increases in same direction → add margin proportionally
   *  • Position decreases in same direction → reduce margin proportionally
   *  • Direction flip (e.g. long → short)   → reset margin based on new net size
   *  • Position reaches zero                 → clear margin
   *
   * Entry price (weighted average):
   *  • New position (size was 0):              entryPrice = tradePrice
   *  • Adding to same-direction position:      entryPrice = (prevSize * prevEntry + delta * tradePrice) / nextSize
   *  • Reducing position (opposite direction): entryPrice unchanged
   *  • Flipping direction:                     entryPrice = tradePrice
   */
  private _update(
    maker:       Address,
    pairId:      string,
    sizeDelta:   bigint,
    marginDelta: bigint,
    mode:        MarginMode,
    tradePrice:  bigint,
  ): void {
    const k          = this.key(maker, pairId)
    const cur        = this.pos.get(k)
    const prev       = cur?.size       ?? 0n
    const pMgn       = cur?.margin     ?? 0n
    const prevEntry  = cur?.entryPrice ?? 0n

    const next     = prev + sizeDelta
    const absPrev  = prev < 0n ? -prev : prev
    const absNext  = next < 0n ? -next : next
    const absDelta = sizeDelta < 0n ? -sizeDelta : sizeDelta

    let nextMargin: bigint
    let nextEntry:  bigint

    if (next === 0n) {
      // Position fully closed — remove entry from map to keep it clean
      this.pos.delete(k)
      return
    } else if (prev === 0n) {
      // New position — use fill margin and trade price directly
      nextMargin = marginDelta
      nextEntry  = tradePrice
    } else if ((prev > 0n) === (next > 0n)) {
      // Same direction
      if (absNext > absPrev) {
        // Growing: add margin; weighted-average entry price
        nextMargin = pMgn + marginDelta
        nextEntry  = absNext > 0n
          ? (absPrev * prevEntry + absDelta * tradePrice) / absNext
          : tradePrice
      } else {
        // Shrinking: reduce margin proportionally; entry price unchanged
        nextMargin = absPrev > 0n ? (pMgn * absNext) / absPrev : 1n
        nextEntry  = prevEntry
      }
    } else {
      // Direction flipped (e.g. long 10 → short 5 after selling 15)
      // New margin ≈ fill margin * (new net size / fill size); entry price resets to trade price
      nextMargin = absDelta > 0n ? (marginDelta * absNext) / absDelta : marginDelta
      nextEntry  = tradePrice
    }

    // Guard: keep at least 1n margin for open positions (prevents false liquidation trigger)
    const state = { size: next, margin: nextMargin > 0n ? nextMargin : 1n, mode, entryPrice: nextEntry }
    this.pos.set(k, state)
    // Note: next===0n case is handled above (early return with map.delete)

    this.emit('position.updated', {
      maker:      maker,
      pairId:     pairId,
      size:       state.size.toString(),
      margin:     state.margin.toString(),
      mode:       state.mode,
      entryPrice: state.entryPrice.toString(),
    })
  }

  getPosition(maker: string, pairId: string): bigint {
    return this.pos.get(this.key(maker, pairId))?.size ?? 0n
  }

  // Returns true if a reduce-only order is valid:
  //   sell (isBuy=false): must have long position >= amount
  //   buy  (isBuy=true):  must have short position with abs >= amount
  canReduceOnly(maker: string, pairId: string, isBuy: boolean, amount: bigint): boolean {
    const p = this.getPosition(maker, pairId)
    return isBuy ? (p < 0n && -p >= amount) : (p > 0n && p >= amount)
  }

  /**
   * Returns all tracked positions as MarginPosition records for liquidation checks.
   *
   * CR-1 fix: margin field is now the estimated actual margin (was always 0n before).
   * Positions with margin=0n would cause LiquidationEngine to flag them all immediately.
   */
  getAll(): MarginPosition[] {
    return [...this.pos.entries()].map(([key, state]) => {
      const colonIdx = key.indexOf(':')
      const maker    = key.slice(0, colonIdx) as Address
      const pairId   = key.slice(colonIdx + 1)
      return { maker, pairId, size: state.size, margin: state.margin, mode: state.mode, entryPrice: state.entryPrice }
    })
  }
}
