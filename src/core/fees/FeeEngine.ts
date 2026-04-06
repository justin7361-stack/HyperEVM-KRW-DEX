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

  /**
   * @param tiers              Protocol fee tiers (volume-based).
   * @param getBrokerFeeRateBps Optional callback to look up broker fee rate for a pairId.
   *                            Returns basis points (0 = disabled). Used for S-2-2 Orderly pattern.
   *                            Typically reads from PairRegistry.brokerFeeRateBps via config or cache.
   */
  constructor(
    private readonly tiers:               FeeTier[] = DEFAULT_TIERS,
    private readonly getBrokerFeeRateBps?: (pairId: string) => number,
  ) {}

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
    const quoteAmount = match.price * match.fillAmount / 10n ** 18n
    // makerFee: positive = charged, negative = rebate (stored as actual value, 0 if zero-fee tier)
    const makerFee = makerTier.makerBps !== 0
      ? quoteAmount * BigInt(makerTier.makerBps) / 10000n
      : 0n
    const takerFee = quoteAmount * BigInt(takerTier.takerBps) / 10000n

    // S-2-2: Broker fee (Orderly pattern) — portion of takerFee routed to broker
    // Only applies when: taker order has a broker AND getBrokerFeeRateBps returns > 0
    let brokerFee: bigint | undefined
    let brokerAddr: string | undefined
    const broker = match.takerOrder.broker
    if (broker && this.getBrokerFeeRateBps) {
      const pairId = `${match.takerOrder.baseToken}/${match.takerOrder.quoteToken}`
      const brokerBps = this.getBrokerFeeRateBps(pairId)
      if (brokerBps > 0) {
        brokerFee  = quoteAmount * BigInt(brokerBps) / 10000n
        brokerAddr = broker
      }
    }

    return { ...match, makerFee, takerFee, brokerFee, brokerAddr }
  }

  // NOTE: assumes tradedAt values are monotonically non-decreasing.
  // Out-of-order insertions can cause volume over-counting.
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
