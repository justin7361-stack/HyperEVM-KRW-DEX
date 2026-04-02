import { EventEmitter } from 'events'
import type { MatchResult, StoredOrder } from '../../types/order.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'
import { OrderBook } from '../orderbook/OrderBook.js'
import type { FeeEngine } from '../fees/FeeEngine.js'

/**
 * Narrow interface for reduce-only position checks.
 * `PositionTracker` satisfies this interface directly.
 */
export interface IPositionReader {
  canReduceOnly(maker: string, pairId: string, isBuy: boolean, amount: bigint): boolean
}

// Events emitted:
//   'matched'  (result: MatchResult)    — one per fill
//   'rejected' (orderId, reason)        — pair not active / pre-check fail / reduce-only violation
//   'price'    (pairId, price: bigint)  — last execution price after each fill
export class MatchingEngine extends EventEmitter {
  private readonly orderbooks = new Map<string, OrderBook>()

  constructor(
    private readonly store: IOrderBookStore,
    private readonly feeEngine?: FeeEngine,
    private readonly positionReader?: IPositionReader,
  ) {
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
    if ((this as any)._paused) {
      this.emit('rejected', order.id, 'Server paused')
      return
    }

    // Reduce-Only enforcement (G-7):
    //   sell reduce-only → requires long position >= order.amount
    //   buy  reduce-only → requires short position with abs >= order.amount
    if (order.reduceOnly) {
      if (!this.positionReader) {
        this.emit('rejected', order.id, 'reduce-only: no position reader configured')
        return
      }
      if (!this.positionReader.canReduceOnly(order.maker, pairId, order.isBuy, order.amount)) {
        this.emit('rejected', order.id, 'reduce-only: no qualifying open position')
        return
      }
    }

    const book = this.getOrCreateBook(pairId)
    const matches = await book.submit(order)
    for (let match of matches) {
      if (this.feeEngine) match = this.feeEngine.onMatch(match)
      this.emit('matched', match)
      this.emit('price', pairId, match.price)
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
