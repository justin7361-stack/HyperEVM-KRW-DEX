import type { StoredOrder } from '../../types/order.js'

type SubmitFn = (order: StoredOrder, pairId: string) => Promise<void>

export class ConditionalOrderEngine {
  private readonly pending = new Map<string, { order: StoredOrder; pairId: string }>()

  constructor(private readonly submitFn: SubmitFn) {}

  add(order: StoredOrder, pairId: string): void {
    this.pending.set(order.id, { order, pairId })
  }

  remove(orderId: string): void {
    this.pending.delete(orderId)
  }

  async onPrice(pairId: string, price: bigint): Promise<void> {
    for (const [id, entry] of this.pending) {
      if (entry.pairId !== pairId) continue
      if (!this.isTriggered(entry.order, price)) continue
      this.pending.delete(id)
      await this.submitFn(entry.order, pairId)
    }
  }

  private isTriggered(order: StoredOrder, price: bigint): boolean {
    const { conditionType, triggerPrice, isBuy } = order
    if (!triggerPrice || !conditionType) return false
    if (conditionType === 'stop_loss')   return isBuy ? price >= triggerPrice : price <= triggerPrice
    if (conditionType === 'take_profit') return isBuy ? price <= triggerPrice : price >= triggerPrice
    return false
  }
}
