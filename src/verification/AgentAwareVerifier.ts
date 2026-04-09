/**
 * Agent-aware order verifier (S-3-2 — Hyperliquid pattern).
 *
 * Wraps EIP712Verifier. When the direct maker signature check fails,
 * attempts to verify the signature was produced by the maker's registered agent.
 *
 * Verification flow:
 *   1. Try: signature recovers to order.maker  → accept
 *   2. Try: signature recovers to agentOf[order.maker] → accept
 *   3. Reject
 */
import { recoverTypedDataAddress } from 'viem'
import type { Address, Hex } from 'viem'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { AgentWalletStore } from './AgentWalletStore.js'
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

export class AgentAwareVerifier implements IOrderVerifier {
  constructor(
    private readonly inner:      IOrderVerifier,
    private readonly agentStore: AgentWalletStore,
    private readonly domain:     Eip712Domain,
  ) {}

  async verify(order: Order, sig: Hex): Promise<boolean> {
    // Step 1: standard maker verification
    if (await this.inner.verify(order, sig)) return true

    // Step 2: check if the signer is the registered agent for this maker
    const agent = this.agentStore.get(order.maker)
    if (!agent) return false

    try {
      const recovered = await recoverTypedDataAddress({
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
      return recovered.toLowerCase() === agent.toLowerCase()
    } catch {
      return false
    }
  }
}
