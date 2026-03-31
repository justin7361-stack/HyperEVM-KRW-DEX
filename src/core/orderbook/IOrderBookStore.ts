import type { OrderBookDepth, StoredOrder } from '../../types/order.js'

export interface IOrderBookStore {
  addOrder(order: StoredOrder): Promise<void>
  removeOrder(orderId: string): Promise<void>
  updateOrder(orderId: string, patch: Partial<StoredOrder>): Promise<void>
  getOrder(orderId: string): Promise<StoredOrder | undefined>
  /** Returns the best open (non-cancelled, non-filled) bid order, or null if none. */
  getBestBid(pairId: string): Promise<StoredOrder | null>
  /** Returns the best open (non-cancelled, non-filled) ask order, or null if none. */
  getBestAsk(pairId: string): Promise<StoredOrder | null>
  getOpenOrders(pairId: string, side: 'buy' | 'sell'): Promise<StoredOrder[]>
  getDepth(pairId: string, levels: number): Promise<OrderBookDepth>
  getOrdersByMaker(maker: string): Promise<StoredOrder[]>
}
