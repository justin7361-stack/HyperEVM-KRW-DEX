import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { Order, StoredOrder } from '../../types/order.js'
import type { Clients } from '../../chain/contracts.js'
import type { Hex } from 'viem'
import { MarginAccount } from '../../margin/MarginAccount.js'
import type { CircuitBreaker } from '../../core/matching/CircuitBreaker.js'

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

interface AmendBody {
  maker:      string
  signature:  Hex
  newPrice?:  string
  newAmount?: string
}

export function ordersRoutes(
  verifier:        IOrderVerifier,
  policy:          PolicyEngine,
  matching:        MatchingEngine,
  store:           IOrderBookStore,
  pairRegistry:    Clients['pairRegistry'],
  marginAccount:   MarginAccount,
  circuitBreaker?: CircuitBreaker,
) {
  return async function (fastify: FastifyInstance) {
    // POST /orders — submit a signed order
    fastify.post<{ Body: SubmitOrderBody }>('/orders', async (req, reply) => {
      const { signature, makerIp = req.ip } = req.body

      // Convert JSON numbers/strings to bigint (HTTP JSON doesn't have bigint type)
      const parsedOrder: Order = {
        ...req.body.order,
        price:    BigInt(req.body.order.price as unknown as string),
        amount:   BigInt(req.body.order.amount as unknown as string),
        nonce:    BigInt(req.body.order.nonce as unknown as string),
        expiry:   BigInt(req.body.order.expiry as unknown as string),
        leverage: req.body.order.leverage != null
          ? BigInt(req.body.order.leverage as unknown as string)
          : undefined,
      }
      const order = parsedOrder

      // 1. Expiry check
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (order.expiry <= now) {
        return reply.status(400).send({ error: 'Order expired' })
      }

      // Client Order ID dedup
      if (order.clientOrderId) {
        const existing = await store.getOrdersByMaker(order.maker)
        const dup = existing.find(
          o => o.clientOrderId === order.clientOrderId && (o.status === 'open' || o.status === 'partial')
        )
        if (dup) {
          return reply.status(409).send({ error: 'Duplicate clientOrderId', orderId: dup.id })
        }
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

      // 5. Margin check — only for Perp orders (order has marginMode set)
      if (order.marginMode) {
        const leverage    = order.leverage ?? 1n
        const notional    = order.amount * order.price / (10n ** 18n)
        const reqMargin   = MarginAccount.requiredMargin(notional, leverage)
        if (!marginAccount.canOpen(order.maker, order.marginMode, reqMargin)) {
          return reply.status(400).send({ error: 'Insufficient margin' })
        }
      }

      // 6. Circuit breaker check
      const pairId = `${order.baseToken}/${order.quoteToken}`
      if (circuitBreaker?.isHalted(pairId)) {
        return reply.status(503).send({ error: `Trading halted for ${pairId}` })
      }

      // 7. Store and match
      const stored: StoredOrder = {
        ...order,
        id:           uuid(),
        signature,
        submittedAt:  Date.now(),
        filledAmount: 0n,
        status:       'open',
        makerIp,
      }

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

    // DELETE /orders — cancel ALL open orders for a maker (optional: filter by pair)
    fastify.delete<{
      Querystring: { maker: string; pair?: string }
    }>('/orders', async (req, reply) => {
      const { maker, pair } = req.query

      if (!maker || !/^0x[0-9a-fA-F]{40}$/.test(maker)) {
        return reply.status(400).send({ error: 'Invalid maker address' })
      }

      const allOrders = await store.getOrdersByMaker(maker)
      const targets = allOrders.filter(o => {
        if (o.status !== 'open' && o.status !== 'partial') return false
        if (pair) {
          const oPairId = `${o.baseToken}/${o.quoteToken}`
          if (oPairId !== pair) return false
        }
        return true
      })

      await Promise.all(targets.map(o => store.updateOrder(o.id, { status: 'cancelled' })))

      return reply.send({ cancelled: targets.length })
    })

    // PUT /orders/:nonce — amend an order (cancel + resubmit with new price/amount)
    fastify.put<{
      Params: { nonce: string }
      Body: AmendBody
    }>('/orders/:nonce', async (req, reply) => {
      const { maker, signature, newPrice, newAmount } = req.body

      if (!maker || !/^0x[0-9a-fA-F]{40}$/.test(maker)) {
        return reply.status(400).send({ error: 'Invalid maker address' })
      }
      if (!newPrice && !newAmount) {
        return reply.status(400).send({ error: 'Provide newPrice or newAmount' })
      }

      // C1 — Guard BigInt conversions
      let nonce: bigint
      let parsedNewPrice: bigint | undefined
      let parsedNewAmount: bigint | undefined
      try {
        nonce = BigInt(req.params.nonce)
        parsedNewPrice  = newPrice  ? BigInt(newPrice)  : undefined
        parsedNewAmount = newAmount ? BigInt(newAmount) : undefined
      } catch {
        return reply.status(400).send({ error: 'Invalid numeric field' })
      }

      const orders = await store.getOrdersByMaker(maker)
      const target = orders.find(
        o => o.nonce === nonce && (o.status === 'open' || o.status === 'partial')
      )
      if (!target) return reply.status(404).send({ error: 'Order not found' })

      // I1 — Expiry check
      if (target.expiry < BigInt(Math.floor(Date.now() / 1000))) {
        return reply.status(400).send({ error: 'Order has expired' })
      }

      // 1. Cancel old order
      await store.updateOrder(target.id, { status: 'cancelled' })

      // 2. Create amended order
      const amended: StoredOrder = {
        ...target,
        id:           uuid(),
        price:        parsedNewPrice  ?? target.price,
        amount:       parsedNewAmount ?? target.amount,
        signature,
        submittedAt:  Date.now(),
        filledAmount: 0n,
        status:       'open',
      }

      // Verify signature on amended order
      const validAmended = await verifier.verify(amended, signature)
      if (!validAmended) {
        await store.updateOrder(target.id, { status: target.status })
        return reply.status(400).send({ error: 'Invalid signature' })
      }

      // I2 — Policy check
      const makerIp = req.ip
      const policyResult = await policy.check({
        maker:      amended.maker,
        taker:      amended.taker,
        baseToken:  amended.baseToken,
        quoteToken: amended.quoteToken,
        amount:     amended.amount,
        price:      amended.price,
        makerIp,
      })
      if (!policyResult.allowed) {
        // Restore old order status since we cancelled it
        await store.updateOrder(target.id, { status: target.status })
        return reply.status(403).send({ error: policyResult.reason ?? 'Compliance check failed' })
      }

      // I3 — Submit with rollback on error
      try {
        const pairId = `${target.baseToken}/${target.quoteToken}`
        await matching.submitOrder(amended, pairId)
      } catch (err) {
        await store.updateOrder(target.id, { status: target.status })
        return reply.status(500).send({ error: 'Failed to submit amended order' })
      }

      // I4 — Return 201
      return reply.status(201).send({ orderId: amended.id })
    })

    // GET /orders/:address — orders for a maker
    // Query params:
    //   ?status=open      → open + partial (default)
    //   ?status=filled    → filled only
    //   ?status=all       → all statuses
    fastify.get<{
      Params: { address: string }
      Querystring: { status?: string }
    }>('/orders/:address', async (req, reply) => {
      const statusFilter = req.query.status ?? 'open'
      const orders = await store.getOrdersByMaker(req.params.address)

      const filtered = orders.filter(o => {
        if (statusFilter === 'all')    return true
        if (statusFilter === 'filled') return o.status === 'filled'
        return o.status === 'open' || o.status === 'partial'
      })

      const serialized = filtered.map(o => ({
        ...o,
        // Map internal id → orderId for frontend compatibility
        orderId:      o.id,
        // Convert all bigint fields to strings for JSON serialization
        price:        o.price.toString(),
        amount:       o.amount.toString(),
        nonce:        o.nonce.toString(),
        expiry:       o.expiry.toString(),
        filledAmount: o.filledAmount.toString(),
        ...(o.leverage      != null && { leverage:      o.leverage.toString() }),
        ...(o.triggerPrice  != null && { triggerPrice:  o.triggerPrice.toString() }),
        ...(o.goodTillTime  != null && { goodTillTime:  o.goodTillTime.toString() }),
      }))
      return reply.type('application/json').send(JSON.stringify({ orders: serialized }))
    })
  }
}
