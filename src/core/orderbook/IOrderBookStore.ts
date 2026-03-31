import type { OrderBookDepth, StoredOrder } from '../../types/order.js'

export interface IOrderBookStore {
  addOrder(order: StoredOrder): Promise<void>
  removeOrder(orderId: string): Promise<void>
  updateOrder(orderId: string, patch: Partial<StoredOrder>): Promise<void>
  getOrder(orderId: string): Promise<StoredOrder | undefined>
  getBestBid(pairId: string): Promise<StoredOrder | null>
  getBestAsk(pairId: string): Promise<StoredOrder | null>
  getOpenOrders(pairId: string, side: 'buy' | 'sell'): Promise<StoredOrder[]>
  getDepth(pairId: string, levels: number): Promise<OrderBookDepth>
  getOrdersByMaker(maker: string): Promise<StoredOrder[]>
}
