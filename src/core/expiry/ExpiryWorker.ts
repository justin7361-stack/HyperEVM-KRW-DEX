import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'

// Scans all open orders every `intervalMs` and expires:
//   1. Orders with expiry <= now (hard deadline, expiry is Unix seconds as bigint)
//   2. GTT orders with goodTillTime <= now (goodTillTime is Unix ms as bigint)
export class ExpiryWorker {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly store: IOrderBookStore,
    private readonly intervalMs = 10_000,   // check every 10 seconds
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, this.intervalMs)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  async sweep(): Promise<number> {
    const now    = BigInt(Math.floor(Date.now() / 1000))
    const nowMs  = BigInt(Date.now())
    const allOrders = (this.store as any).getAllOpenOrders?.() as import('../../types/order.js').StoredOrder[] | undefined
    if (!allOrders) return 0

    let count = 0
    for (const order of allOrders) {
      if (order.status !== 'open' && order.status !== 'partial') continue
      const hardExpired = order.expiry <= now
      const gttExpired  = order.timeInForce === 'GTT' && order.goodTillTime != null && order.goodTillTime <= nowMs
      if (hardExpired || gttExpired) {
        await this.store.updateOrder(order.id, { status: 'expired' })
        count++
      }
    }
    return count
  }
}
