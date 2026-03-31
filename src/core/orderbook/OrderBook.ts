import type { MatchResult, StoredOrder, OrderBookDepth } from '../../types/order.js'
import type { IOrderBookStore } from './IOrderBookStore.js'

export class OrderBook {
  constructor(
    private readonly store: IOrderBookStore,
    private readonly pairId: string,
  ) {}

  // Submit an order, run matching, return all matches produced
  async submit(order: StoredOrder): Promise<MatchResult[]> {
    // Post-Only: if the order would immediately cross the spread, cancel it
    if (order.timeInForce === 'POST_ONLY') {
      const wouldCross = await this.wouldCrossSpread(order)
      if (wouldCross) {
        const cancelled = { ...order, status: 'cancelled' as const }
        await this.store.addOrder(cancelled)
        return []
      }
    }

    // FOK: check total available liquidity before matching
    if (order.timeInForce === 'FOK') {
      const available = await this.getTotalAvailable(order)
      if (available < order.amount) {
        const cancelled = { ...order, status: 'cancelled' as const }
        await this.store.addOrder(cancelled)
        return []
      }
    }

    await this.store.addOrder(order)
    return this.runMatching(order)
  }

  // Check if order would immediately match (cross the spread)
  private async wouldCrossSpread(order: StoredOrder): Promise<boolean> {
    const counter = order.isBuy
      ? await this.store.getBestAsk(this.pairId)
      : await this.store.getBestBid(this.pairId)
    if (!counter) return false
    const bid = order.isBuy ? order : counter
    const ask = order.isBuy ? counter : order
    return bid.price >= ask.price
  }

  // Sum total fillable quantity from opposite side at acceptable prices.
  // NOTE: This check is a pre-flight estimate, not a lock. Under the current
  // single-threaded in-memory store, the result is always accurate at match time.
  // If the store is replaced with a concurrent/persistent implementation, a TOCTOU
  // race could cause this estimate to be stale. The FOK post-match cancellation
  // in runMatching acts as a safety net in that scenario.
  private async getTotalAvailable(order: StoredOrder): Promise<bigint> {
    const side = order.isBuy ? 'sell' : 'buy'
    const orders = await this.store.getOpenOrders(this.pairId, side)
    const priceOk = (o: StoredOrder) =>
      order.isBuy ? order.price >= o.price : order.price <= o.price
    return orders
      .filter(priceOk)
      .reduce((sum, o) => sum + (o.amount - o.filledAmount), 0n)
  }

  async getDepth(levels: number): Promise<OrderBookDepth> {
    return this.store.getDepth(this.pairId, levels)
  }

  async removeOrder(orderId: string): Promise<void> {
    await this.store.removeOrder(orderId)
  }

  private async runMatching(incoming: StoredOrder): Promise<MatchResult[]> {
    const results: MatchResult[] = []

    while (true) {
      const cur = await this.store.getOrder(incoming.id)
      if (!cur || (cur.status !== 'open' && cur.status !== 'partial')) break

      const remaining = cur.amount - cur.filledAmount
      if (remaining <= 0n) break

      const counter = cur.isBuy
        ? await this.store.getBestAsk(this.pairId)
        : await this.store.getBestBid(this.pairId)
      if (!counter || counter.id === cur.id) break

      // Price check — skip when either side is a market order
      const isMarket = cur.orderType === 'market' || counter.orderType === 'market'
      if (!isMarket) {
        const bid = cur.isBuy ? cur : counter
        const ask = cur.isBuy ? counter : cur
        if (bid.price < ask.price) break
      }

      // Execute at the limit (resting) order's price
      const execPrice = counter.price
      const counterRem = counter.amount - counter.filledAmount
      const fill       = remaining < counterRem ? remaining : counterRem

      const newCurFill     = cur.filledAmount     + fill
      const newCounterFill = counter.filledAmount + fill

      await this.store.updateOrder(cur.id, {
        filledAmount: newCurFill,
        status: newCurFill >= cur.amount ? 'filled' : 'partial',
      })
      await this.store.updateOrder(counter.id, {
        filledAmount: newCounterFill,
        status: newCounterFill >= counter.amount ? 'filled' : 'partial',
      })

      results.push({
        makerOrder: cur.isBuy ? counter : cur,
        takerOrder: cur.isBuy ? cur     : counter,
        fillAmount: fill,
        price:      execPrice,
        matchedAt:  Date.now(),
      })
    }

    // IOC / market / FOK: cancel unfilled remainder immediately
    if (
      incoming.orderType === 'market' ||
      incoming.timeInForce === 'IOC' ||
      incoming.timeInForce === 'FOK'
    ) {
      const final = await this.store.getOrder(incoming.id)
      if (final && (final.status === 'open' || final.status === 'partial')) {
        await this.store.updateOrder(incoming.id, { status: 'cancelled' })
      }
    }

    return results
  }
}
