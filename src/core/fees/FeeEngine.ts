import type { FeeTier, MatchResult } from '../../types/order.js'

const DEFAULT_TIERS: FeeTier[] = [
  { minVolume30d: 0n,          makerBps: 1,  takerBps: 3 },
  { minVolume30d: 1_000_000n,  makerBps: 0,  takerBps: 2 },
  { minVolume30d: 10_000_000n, makerBps: -1, takerBps: 1 },
]

export class FeeEngine {
  // 30-day rolling volume per maker (baseToken units)
  private readonly volume30d = new Map<string, bigint>()
  // Trade history for rolling window eviction
  private readonly trades: { maker: string; amount: bigint; tradedAt: number }[] = []

  constructor(private readonly tiers: FeeTier[] = DEFAULT_TIERS) {}

  onMatch(match: MatchResult): MatchResult {
    const makerAddress = match.makerOrder.maker.toLowerCase()
    const takerAddress = match.takerOrder.maker.toLowerCase()

    // Update 30d rolling volumes
    this.updateVolume(makerAddress, match.fillAmount, match.matchedAt)
    this.updateVolume(takerAddress, match.fillAmount, match.matchedAt)

    const makerTier = this.getTier(makerAddress)
    const takerTier = this.getTier(takerAddress)

    // Fee in quoteToken: fee = price * amount * bps / 10000
    // price and amount are 18-decimal fixed-point, so divide by 1e18 to get actual quote value
    const quoteAmount = match.price * match.fillAmount / BigInt(1e18)
    // makerFee: positive = charged, negative = rebate (stored as actual value, 0 if zero-fee tier)
    const makerFee = makerTier.makerBps !== 0
      ? quoteAmount * BigInt(Math.abs(makerTier.makerBps)) / 10000n * BigInt(makerTier.makerBps < 0 ? -1 : 1)
      : 0n
    const takerFee = quoteAmount * BigInt(takerTier.takerBps) / 10000n

    return { ...match, makerFee, takerFee }
  }

  private updateVolume(maker: string, amount: bigint, tradedAt: number): void {
    const cutoff = tradedAt - 30 * 24 * 3600 * 1000
    // Evict trades older than 30 days
    while (this.trades.length > 0 && this.trades[0].tradedAt < cutoff) {
      const old = this.trades.shift()!
      const v = this.volume30d.get(old.maker) ?? 0n
      this.volume30d.set(old.maker, v > old.amount ? v - old.amount : 0n)
    }
    this.trades.push({ maker, amount, tradedAt })
    this.volume30d.set(maker, (this.volume30d.get(maker) ?? 0n) + amount)
  }

  getTier(maker: string): FeeTier {
    const vol = this.volume30d.get(maker.toLowerCase()) ?? 0n
    return [...this.tiers].reverse().find(t => vol >= t.minVolume30d) ?? this.tiers[0]
  }
}
