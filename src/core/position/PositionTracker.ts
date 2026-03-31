import type { MatchResult } from '../../types/order.js'

// Tracks net baseToken position per (maker, pairId).
// Positive = long (net buyer), Negative = short (net seller).
export class PositionTracker {
  private readonly pos = new Map<string, bigint>()

  private key(maker: string, pairId: string): string {
    return `${maker.toLowerCase()}:${pairId}`
  }

  onMatch(pairId: string, match: MatchResult): void {
    const k = this.key(match.makerOrder.maker, pairId)
    const cur = this.pos.get(k) ?? 0n
    this.pos.set(k, match.makerOrder.isBuy ? cur + match.fillAmount : cur - match.fillAmount)
  }

  getPosition(maker: string, pairId: string): bigint {
    return this.pos.get(this.key(maker, pairId)) ?? 0n
  }

  // Returns true if a reduce-only order is valid:
  //   sell (isBuy=false): must have long position >= amount
  //   buy  (isBuy=true):  must have short position with abs >= amount
  canReduceOnly(maker: string, pairId: string, isBuy: boolean, amount: bigint): boolean {
    const p = this.getPosition(maker, pairId)
    return isBuy ? (p < 0n && -p >= amount) : (p > 0n && p >= amount)
  }
}
