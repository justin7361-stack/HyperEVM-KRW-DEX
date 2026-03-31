import type { IOrderBookStore } from './IOrderBookStore.js'
import type { OrderBookDepth, PriceLevel, StoredOrder } from '../../types/order.js'

export class MemoryOrderBookStore implements IOrderBookStore {
  private readonly orders = new Map<string, StoredOrder>()

  async addOrder(order: StoredOrder): Promise<void> {
    this.orders.set(order.id, { ...order })
  }

  async removeOrder(orderId: string): Promise<void> {
    this.orders.delete(orderId)
  }

  async updateOrder(orderId: string, patch: Partial<StoredOrder>): Promise<void> {
    const order = this.orders.get(orderId)
    if (order) {
      this.orders.set(orderId, { ...order, ...patch })
    }
  }

  async getOrder(orderId: string): Promise<StoredOrder | undefined> {
    return this.orders.get(orderId)
  }

  async getBestBid(pairId: string): Promise<StoredOrder | null> {
    const bids = this.getActiveOrdersForPair(pairId, true)
    if (bids.length === 0) return null
    // Price DESC, then submittedAt ASC (FIFO at same price)
    bids.sort((a, b) => {
      if (b.price !== a.price) return b.price > a.price ? 1 : -1
      return a.submittedAt - b.submittedAt
    })
    return bids[0]
  }

  async getBestAsk(pairId: string): Promise<StoredOrder | null> {
    const asks = this.getActiveOrdersForPair(pairId, false)
    if (asks.length === 0) return null
    // Price ASC, then submittedAt ASC (FIFO at same price)
    asks.sort((a, b) => {
      if (a.price !== b.price) return a.price < b.price ? -1 : 1
      return a.submittedAt - b.submittedAt
    })
    return asks[0]
  }

  async getOpenOrders(pairId: string, side: 'buy' | 'sell'): Promise<StoredOrder[]> {
    return this.getActiveOrdersForPair(pairId, side === 'buy')
  }

  async getDepth(pairId: string, levels: number): Promise<OrderBookDepth> {
    const bids = this.getActiveOrdersForPair(pairId, true)
    const asks = this.getActiveOrdersForPair(pairId, false)

    const aggregateByPrice = (orders: StoredOrder[], descending: boolean): PriceLevel[] => {
      const map = new Map<bigint, PriceLevel>()
      for (const o of orders) {
        const remaining = o.amount - o.filledAmount
        if (remaining <= 0n) continue
        const existing = map.get(o.price)
        if (existing) {
          existing.amount += remaining
          existing.orderCount++
        } else {
          map.set(o.price, { price: o.price, amount: remaining, orderCount: 1 })
        }
      }
      const levels_ = [...map.values()]
      if (descending) {
        levels_.sort((a, b) => b.price > a.price ? 1 : -1)
      } else {
        levels_.sort((a, b) => a.price < b.price ? -1 : 1)
      }
      return levels_.slice(0, levels)
    }

    return {
      pairId,
      bids: aggregateByPrice(bids, true),
      asks: aggregateByPrice(asks, false),
      timestamp: Date.now(),
    }
  }

  async getOrdersByMaker(maker: string): Promise<StoredOrder[]> {
    return [...this.orders.values()].filter(o => o.maker.toLowerCase() === maker.toLowerCase())
  }

  private getActiveOrdersForPair(pairId: string, isBuy: boolean): StoredOrder[] {
    return [...this.orders.values()].filter(o => {
      const oPairId = `${o.baseToken}/${o.quoteToken}`
      return (
        oPairId === pairId &&
        o.isBuy === isBuy &&
        (o.status === 'open' || o.status === 'partial') &&
        o.orderType !== 'market'   // market orders have no price → exclude from depth
      )
    })
  }
}
