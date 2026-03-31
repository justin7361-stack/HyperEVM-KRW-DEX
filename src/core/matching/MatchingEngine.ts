import { EventEmitter } from 'events'
import type { MatchResult, StoredOrder } from '../../types/order.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'
import { OrderBook } from '../orderbook/OrderBook.js'

// Events emitted:
//   'matched'  (result: MatchResult)    — one per fill
//   'rejected' (orderId, reason)        — pair not active / pre-check fail
export class MatchingEngine extends EventEmitter {
  private readonly orderbooks = new Map<string, OrderBook>()

  constructor(private readonly store: IOrderBookStore) {
    super()
  }

  private getOrCreateBook(pairId: string): OrderBook {
    let book = this.orderbooks.get(pairId)
    if (!book) {
      book = new OrderBook(this.store, pairId)
      this.orderbooks.set(pairId, book)
    }
    return book
  }

  async submitOrder(order: StoredOrder, pairId: string): Promise<void> {
    const book = this.getOrCreateBook(pairId)
    const matches = await book.submit(order)
    for (const match of matches) {
      this.emit('matched', match)
    }
  }

  async cancelOrder(orderId: string, pairId: string): Promise<void> {
    const book = this.getOrCreateBook(pairId)
    await book.removeOrder(orderId)
  }

  async getDepth(pairId: string, levels = 20) {
    return this.getOrCreateBook(pairId).getDepth(levels)
  }
}
