import type { IPolicyPlugin, PolicyResult, TradeContext } from './IPolicyPlugin.js'

export class PolicyEngine {
  private readonly plugins: IPolicyPlugin[] = []

  register(plugin: IPolicyPlugin): void {
    this.plugins.push(plugin)
  }

  async check(ctx: TradeContext): Promise<PolicyResult> {
    for (const plugin of this.plugins) {
      const result = await plugin.check(ctx)
      if (!result.allowed) return result
    }
    return { allowed: true }
  }
}
