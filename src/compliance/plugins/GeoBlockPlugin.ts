import geoip from 'geoip-lite'
import type { IPolicyPlugin, PolicyResult, TradeContext } from '../IPolicyPlugin.js'

export class GeoBlockPlugin implements IPolicyPlugin {
  readonly name = 'GeoBlockPlugin'

  constructor(private readonly blockedCountries: Set<string>) {}

  async check(ctx: TradeContext): Promise<PolicyResult> {
    if (!ctx.makerIp) return { allowed: true }
    const geo = geoip.lookup(ctx.makerIp)
    if (geo && this.blockedCountries.has(geo.country)) {
      return { allowed: false, reason: `Country ${geo.country} is geo-blocked` }
    }
    return { allowed: true }
  }
}
