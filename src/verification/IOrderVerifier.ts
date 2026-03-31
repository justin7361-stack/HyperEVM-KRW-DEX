import type { Hex } from 'viem'
import type { Order } from '../types/order.js'

export interface IOrderVerifier {
  verify(order: Order, sig: Hex): Promise<boolean>
}
