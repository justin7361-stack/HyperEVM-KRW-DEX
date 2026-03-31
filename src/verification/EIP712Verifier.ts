import { verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { Order } from '../types/order.js'

const ORDER_TYPES = {
  Order: [
    { name: 'maker',      type: 'address' },
    { name: 'taker',      type: 'address' },
    { name: 'baseToken',  type: 'address' },
    { name: 'quoteToken', type: 'address' },
    { name: 'price',      type: 'uint256' },
    { name: 'amount',     type: 'uint256' },
    { name: 'isBuy',      type: 'bool'    },
    { name: 'nonce',      type: 'uint256' },
    { name: 'expiry',     type: 'uint256' },
  ],
} as const

interface Eip712Domain {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
}

export class EIP712Verifier implements IOrderVerifier {
  constructor(private readonly domain: Eip712Domain) {}

  async verify(order: Order, sig: Hex): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: order.maker,
        domain: this.domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
          maker:      order.maker,
          taker:      order.taker,
          baseToken:  order.baseToken,
          quoteToken: order.quoteToken,
          price:      order.price,
          amount:     order.amount,
          isBuy:      order.isBuy,
          nonce:      order.nonce,
          expiry:     order.expiry,
        },
        signature: sig,
      })
    } catch {
      return false
    }
  }
}
