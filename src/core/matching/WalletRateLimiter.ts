/**
 * WalletRateLimiter — sliding window rate limit per maker address.
 * Default: max 10 orders per 1 second per wallet.
 *
 * Uses a Map<address, number[]> of timestamps.
 * On each check: purge timestamps older than windowMs, then count remaining.
 */
export class WalletRateLimiter {
  private readonly windows = new Map<string, number[]>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(private cfg: {
    maxRequests: number  // e.g. 10
    windowMs:   number   // e.g. 1000 (1 second)
  }) {
    // Cleanup stale entries every 60s to prevent memory leak
    this.cleanupTimer = setInterval(() => this._cleanup(), 60_000)
  }

  /**
   * Returns true if the wallet is allowed to submit an order.
   * Records the attempt regardless of result.
   */
  isAllowed(address: string): boolean {
    const now = Date.now()
    const key = address.toLowerCase()
    const timestamps = this.windows.get(key) ?? []

    // Purge entries outside the window
    const windowStart = now - this.cfg.windowMs
    const recent = timestamps.filter(t => t > windowStart)
    recent.push(now)
    this.windows.set(key, recent)

    return recent.length <= this.cfg.maxRequests
  }

  /** Remaining requests this second for an address */
  remaining(address: string): number {
    const now = Date.now()
    const key = address.toLowerCase()
    const timestamps = this.windows.get(key) ?? []
    const windowStart = now - this.cfg.windowMs
    const recent = timestamps.filter(t => t > windowStart)
    return Math.max(0, this.cfg.maxRequests - recent.length)
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
  }

  private _cleanup(): void {
    const now = Date.now()
    const windowStart = now - this.cfg.windowMs
    for (const [key, timestamps] of this.windows) {
      const recent = timestamps.filter(t => t > windowStart)
      if (recent.length === 0) {
        this.windows.delete(key)
      } else {
        this.windows.set(key, recent)
      }
    }
  }
}
