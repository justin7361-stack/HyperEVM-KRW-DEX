/**
 * In-memory store for agent wallet delegations (S-3-2 — Hyperliquid pattern).
 *
 * A trader can authorize an "agent" address to sign orders on their behalf.
 * This allows using a hot wallet (agent) for signing while the main wallet
 * (trader) holds funds and controls the delegation.
 *
 * One active agent per trader at a time. Delegation is revocable.
 */
export class AgentWalletStore {
  /** trader (lowercase) → agent (lowercase) */
  private readonly agents = new Map<string, string>()

  /** Approve an agent for a trader. Overwrites any existing agent. */
  set(trader: string, agent: string): void {
    this.agents.set(trader.toLowerCase(), agent.toLowerCase())
  }

  /** Returns the current agent for a trader, or undefined if none. */
  get(trader: string): string | undefined {
    return this.agents.get(trader.toLowerCase())
  }

  /** Revoke the agent for a trader. Returns true if an entry existed. */
  delete(trader: string): boolean {
    return this.agents.delete(trader.toLowerCase())
  }

  /** Returns all active delegations (for diagnostics). */
  getAll(): Array<{ trader: string; agent: string }> {
    return Array.from(this.agents.entries()).map(([trader, agent]) => ({ trader, agent }))
  }
}
