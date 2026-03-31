import type { FastifyInstance } from 'fastify'
import type { FundingRateEngine } from '../../core/funding/FundingRateEngine.js'

export function fundingRoutes(
  engine: FundingRateEngine,
  getMarkPrice:  (pair: string) => bigint,
  getIndexPrice: (pair: string) => bigint,
) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/funding/:pair', async (req, reply) => {
      const pairId = decodeURIComponent(req.params.pair)
      const rate = engine.computeRate(getMarkPrice(pairId), getIndexPrice(pairId))
      return reply.send({
        ...rate,
        pairId,
        markPrice:  rate.markPrice.toString(),
        indexPrice: rate.indexPrice.toString(),
      })
    })
  }
}
