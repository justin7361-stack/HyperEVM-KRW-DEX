/**
 * Dead Man's Switch — Hyperliquid pattern (S-1-1).
 *
 * Market makers call set(maker, seconds) to schedule automatic cancellation
 * of all their open orders after `seconds`. If the connection drops, orders
 * are cancelled automatically. Calling set() again resets the timer (heartbeat
 * pattern — e.g. send every 30s with seconds=60 to maintain a 30s safety window).
 * Calling clear() or set(maker, 0) disables the switch.
 *
 * Reference: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/cancel#cancel-after
 * Min seconds: 5 (matches Hyperliquid minimum lead time)
 * Max seconds: 86400 (24 h cap)
 */
export class CancelAfterManager {
  private readonly timers    = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly scheduled = new Map<string, number>()   // maker.lower → cancelAt (Unix ms)

  static readonly MIN_SECONDS = 5
  static readonly MAX_SECONDS = 86_400  // 24 hours

  /**
   * @param cancelAllFn Called when the switch fires.
   *   Receives the maker address and must cancel all open orders.
   *   Returns the number of orders cancelled.
   */
  constructor(
    private readonly cancelAllFn: (maker: string) => Promise<number>,
  ) {}

  /**
   * Schedule cancellation after `seconds`.
   * Calling again replaces the existing timer (heartbeat pattern).
   * seconds = 0 → alias for clear().
   *
   * Returns { cancelAt } (Unix ms) on success or { error } on validation failure.
   */
  set(maker: string, seconds: number): { cancelAt: number } | { error: string } {
    if (seconds === 0) {
      this.clear(maker)
      return { cancelAt: 0 }
    }
    if (!Number.isInteger(seconds) || seconds < CancelAfterManager.MIN_SECONDS) {
      return { error: `seconds must be an integer >= ${CancelAfterManager.MIN_SECONDS} (minimum lead time)` }
    }
    if (seconds > CancelAfterManager.MAX_SECONDS) {
      return { error: `seconds must be <= ${CancelAfterManager.MAX_SECONDS} (24 h max)` }
    }

    // Replace any existing timer
    this._clearTimer(maker)

    const cancelAt = Date.now() + seconds * 1000
    const k        = maker.toLowerCase()

    const timer = setTimeout(() => {
      this.timers.delete(k)
      this.scheduled.delete(k)
      void this.cancelAllFn(maker)
        .then(count => console.log(`[CancelAfter] switch fired — cancelled ${count} orders for ${maker}`))
        .catch(err  => console.error(`[CancelAfter] failed to cancel orders for ${maker}:`, err))
    }, seconds * 1000)

    this.timers.set(k, timer)
    this.scheduled.set(k, cancelAt)
    return { cancelAt }
  }

  /**
   * Disable the Dead Man's Switch for this maker.
   * Returns true if a timer was active and cleared, false if none was set.
   */
  clear(maker: string): boolean {
    return this._clearTimer(maker)
  }

  /**
   * Returns the scheduled cancellation timestamp (Unix ms),
   * or null if no switch is active for this maker.
   */
  getScheduledAt(maker: string): number | null {
    return this.scheduled.get(maker.toLowerCase()) ?? null
  }

  /** Clear all timers — call during graceful shutdown. */
  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.scheduled.clear()
  }

  private _clearTimer(maker: string): boolean {
    const k     = maker.toLowerCase()
    const timer = this.timers.get(k)
    if (!timer) return false
    clearTimeout(timer)
    this.timers.delete(k)
    this.scheduled.delete(k)
    return true
  }
}
