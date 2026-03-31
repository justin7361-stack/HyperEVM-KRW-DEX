import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { Clients } from '../../chain/contracts.js'
import type { Order, StoredOrder } from '../../types/order.js'
import type { Hex } from 'viem'

interface BatchSubmitItem {
  order:     Omit<Order, 'price' | 'amount' | 'nonce' | 'expiry' | 'triggerPrice'> & {
    price: string; amount: string; nonce: string; expiry: string; triggerPrice?: string
  }
  signature: Hex
  makerIp?:  string
}

interface BatchResult {
  index:   number
  orderId?: string
  error?:  string
}

export function ordersBatchRoutes(
  verifier:     IOrderVerifier,
  policy:       PolicyEngine,
  matching:     MatchingEngine,
  store:        IOrderBookStore,
  pairRegistry: Clients['pairRegistry'],
) {
  return async function (fastify: FastifyInstance) {
    // POST /orders/batch — submit up to 50 orders
    fastify.post<{ Body: { orders: BatchSubmitItem[] } }>(
      '/orders/batch',
      async (req, reply) => {
        const { orders } = req.body
        if (!Array.isArray(orders) || orders.length === 0) {
          return reply.status(400).send({ error: 'orders array required' })
        }
        if (orders.length > 50) {
          return reply.status(400).send({ error: 'Maximum 50 orders per batch' })
        }

        const results: BatchResult[] = []
        const now = BigInt(Math.floor(Date.now() / 1000))

        for (let i = 0; i < orders.length; i++) {
          const item = orders[i]
          try {
            const order: Order = {
              ...item.order,
              price:        BigInt(item.order.price),
              amount:       BigInt(item.order.amount),
              nonce:        BigInt(item.order.nonce),
              expiry:       BigInt(item.order.expiry),
              triggerPrice: item.order.triggerPrice ? BigInt(item.order.triggerPrice) : undefined,
            }

            if (order.expiry <= now) throw new Error('Order expired')

            const valid = await verifier.verify(order, item.signature)
            if (!valid) throw new Error('Invalid signature')

            const tradeAllowed = await pairRegistry.read.isTradeAllowed([order.baseToken, order.quoteToken])
            if (!tradeAllowed) throw new Error('Trading pair not active')

            const policyResult = await policy.check({
              maker: order.maker, taker: order.taker,
              baseToken: order.baseToken, quoteToken: order.quoteToken,
              amount: order.amount, price: order.price,
              makerIp: item.makerIp ?? 'batch',
            })
            if (!policyResult.allowed) throw new Error(policyResult.reason ?? 'Compliance check failed')

            const stored: StoredOrder = {
              ...order,
              id: uuid(), signature: item.signature,
              submittedAt: Date.now(), filledAmount: 0n,
              status: 'open', makerIp: item.makerIp ?? 'batch',
            }
            const pairId = `${order.baseToken}/${order.quoteToken}`
            await matching.submitOrder(stored, pairId)
            results.push({ index: i, orderId: stored.id })
          } catch (err: any) {
            results.push({ index: i, error: err.message ?? 'Unknown error' })
          }
        }

        return reply.status(207).send({ results })
      }
    )
  }
}
