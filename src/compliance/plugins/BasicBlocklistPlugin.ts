import type { Address } from 'viem'
import type { IPolicyPlugin, PolicyResult, TradeContext } from '../IPolicyPlugin.js'

export class BasicBlocklistPlugin implements IPolicyPlugin {
  readonly name = 'BasicBlocklistPlugin'

  constructor(private readonly blocked: Set<Address>) {}

  async check(ctx: TradeContext): Promise<PolicyResult> {
    if (this.blocked.has(ctx.maker)) {
      return { allowed: false, reason: `Maker ${ctx.maker} is on the blocklist` }
    }
    if (this.blocked.has(ctx.taker)) {
      return { allowed: false, reason: `Taker ${ctx.taker} is on the blocklist` }
    }
    return { allowed: true }
  }
}
