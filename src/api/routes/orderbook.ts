import type { FastifyInstance } from 'fastify'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'

export function orderbookRoutes(matching: MatchingEngine) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/orderbook/:pair', async (req, reply) => {
      const pairId = decodeURIComponent(req.params.pair)
      const depth  = await matching.getDepth(pairId, 20)
      return reply.send({
        pairId:    depth.pairId,
        timestamp: depth.timestamp,
        bids: depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString(), orderCount: l.orderCount })),
        asks: depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString(), orderCount: l.orderCount })),
      })
    })
  }
}
