import { EventEmitter } from 'events'
import type { StoredOrder } from '../../types/order.js'

type SubmitFn = (order: StoredOrder, pairId: string) => Promise<void>

/**
 * Manages resting conditional (stop-loss / take-profit) orders.
 *
 * Trigger semantics (G-8 — reference: dYdX v4 conditional orders):
 *   stop_loss  sell: fires when price <= triggerPrice  (long position stops out)
 *   stop_loss  buy:  fires when price >= triggerPrice  (short position stops out)
 *   take_profit sell: fires when price >= triggerPrice (long position takes profit)
 *   take_profit buy:  fires when price <= triggerPrice (short position takes profit)
 *
 * Events emitted:
 *   'triggered' (orderId: string, pairId: string)  — condition met, submitFn called
 *   'expired'   (orderId: string, pairId: string)  — expiry passed, purged without submission
 *   'error'     (orderId: string, err: unknown)    — submitFn threw; order is re-queued
 */
export class ConditionalOrderEngine extends EventEmitter {
  private readonly pending = new Map<string, { order: StoredOrder; pairId: string }>()

  constructor(private readonly submitFn: SubmitFn) {
    super()
  }

  add(order: StoredOrder, pairId: string): void {
    this.pending.set(order.id, { order, pairId })
  }

  remove(orderId: string): void {
    this.pending.delete(orderId)
  }

  /** Returns the number of pending conditional orders. */
  getCount(): number {
    return this.pending.size
  }

  async onPrice(pairId: string, price: bigint): Promise<void> {
    const nowSec = BigInt(Math.floor(Date.now() / 1000))

    // Snapshot to prevent re-processing entries that are re-inserted after an error
    for (const [id, entry] of [...this.pending]) {
      if (entry.pairId !== pairId) continue

      // Expiry check: purge without submitting and emit 'expired'
      if (entry.order.expiry != null && entry.order.expiry <= nowSec) {
        this.pending.delete(id)
        this.emit('expired', id, pairId)
        continue
      }

      if (!this.isTriggered(entry.order, price)) continue

      this.pending.delete(id)
      this.emit('triggered', id, pairId)
      try {
        await this.submitFn(entry.order, pairId)
      } catch (err) {
        // Re-insert so the order is not permanently lost on transient errors
        this.pending.set(id, entry)
        this.emit('error', id, err)
        console.error(`ConditionalOrderEngine: submitFn failed for order ${id}:`, err)
      }
    }
  }

  private isTriggered(order: StoredOrder, price: bigint): boolean {
    const { conditionType, triggerPrice, isBuy } = order
    if (triggerPrice == null || !conditionType) return false
    if (conditionType === 'stop_loss')   return isBuy ? price >= triggerPrice : price <= triggerPrice
    if (conditionType === 'take_profit') return isBuy ? price <= triggerPrice : price >= triggerPrice
    return false
  }
}
