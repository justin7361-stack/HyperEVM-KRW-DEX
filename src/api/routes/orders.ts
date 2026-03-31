import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { Order, StoredOrder } from '../../types/order.js'
import type { Clients } from '../../chain/contracts.js'
import type { Hex } from 'viem'

interface SubmitOrderBody {
  order:     Order
  signature: Hex
  makerIp?:  string
}

interface CancelOrderParams {
  nonce: string
}
interface CancelOrderBody {
  maker: string
}

export function ordersRoutes(
  verifier:     IOrderVerifier,
  policy:       PolicyEngine,
  matching:     MatchingEngine,
  store:        IOrderBookStore,
  pairRegistry: Clients['pairRegistry'],
) {
  return async function (fastify: FastifyInstance) {
    // POST /orders — submit a signed order
    fastify.post<{ Body: SubmitOrderBody }>('/orders', async (req, reply) => {
      const { signature, makerIp = req.ip } = req.body

      // Convert JSON numbers/strings to bigint (HTTP JSON doesn't have bigint type)
      const parsedOrder: Order = {
        ...req.body.order,
        price:  BigInt(req.body.order.price as unknown as string),
        amount: BigInt(req.body.order.amount as unknown as string),
        nonce:  BigInt(req.body.order.nonce as unknown as string),
        expiry: BigInt(req.body.order.expiry as unknown as string),
      }
      const order = parsedOrder

      // 1. Expiry check
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (order.expiry <= now) {
        return reply.status(400).send({ error: 'Order expired' })
      }

      // 2. EIP-712 signature verification
      const valid = await verifier.verify(order, signature)
      if (!valid) {
        return reply.status(400).send({ error: 'Invalid signature' })
      }

      // 3. PairRegistry check — reject if pair is not active
      const tradeAllowed = await pairRegistry.read.isTradeAllowed([order.baseToken, order.quoteToken])
      if (!tradeAllowed) {
        return reply.status(400).send({ error: 'Trading pair not active' })
      }

      // 4. Policy check (fail-closed)
      const policyResult = await policy.check({
        maker:      order.maker,
        taker:      order.taker,
        baseToken:  order.baseToken,
        quoteToken: order.quoteToken,
        amount:     order.amount,
        price:      order.price,
        makerIp,
      })
      if (!policyResult.allowed) {
        return reply.status(403).send({ error: policyResult.reason ?? 'Compliance check failed' })
      }

      // 5. Store and match
      const stored: StoredOrder = {
        ...order,
        id:           uuid(),
        signature,
        submittedAt:  Date.now(),
        filledAmount: 0n,
        status:       'open',
        makerIp,
      }

      const pairId = `${order.baseToken}/${order.quoteToken}`
      await matching.submitOrder(stored, pairId)

      return reply.status(201).send({ orderId: stored.id })
    })

    // DELETE /orders/:nonce — cancel an order
    fastify.delete<{ Params: CancelOrderParams; Body: CancelOrderBody }>(
      '/orders/:nonce',
      async (req, reply) => {
        const { maker } = req.body

        // Validate maker is a valid Ethereum address format
        if (!maker || !/^0x[0-9a-fA-F]{40}$/.test(maker)) {
          return reply.status(400).send({ error: 'Invalid maker address' })
        }

        const nonce = BigInt(req.params.nonce)

        const orders = await store.getOrdersByMaker(maker)
        const target = orders.find(o => o.nonce === nonce && o.status === 'open')
        if (!target) {
          return reply.status(404).send({ error: 'Order not found' })
        }

        await store.updateOrder(target.id, { status: 'cancelled' })
        return reply.send({ cancelled: true })
      },
    )

    // GET /orders/:address — open orders for a maker
    fastify.get<{ Params: { address: string } }>('/orders/:address', async (req, reply) => {
      const orders = await store.getOrdersByMaker(req.params.address)
      return reply.send({
        orders: orders
          .filter(o => o.status === 'open')
          .map(o => ({
            ...o,
            price:        o.price.toString(),
            amount:       o.amount.toString(),
            nonce:        o.nonce.toString(),
            expiry:       o.expiry.toString(),
            filledAmount: o.filledAmount.toString(),
          })),
      })
    })
  }
}
