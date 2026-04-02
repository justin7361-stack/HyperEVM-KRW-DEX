import type { FastifyInstance } from 'fastify'
import type { FundingRateEngine } from '../../core/funding/FundingRateEngine.js'

export function fundingRoutes(
  engine: FundingRateEngine,
  getMarkPrice:  (pair: string) => bigint,
  getIndexPrice: (pair: string) => bigint,
) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/funding/:pair', async (req, reply) => {
      const pairId  = decodeURIComponent(req.params.pair)
      const funding = engine.computeRate(getMarkPrice(pairId), getIndexPrice(pairId))

      // Convert rate (number 0..1) to bigint scaled by 1e18 for frontend
      const rateScaled = BigInt(Math.round(funding.rate * 1e18))

      // Next 8-hour funding interval (00:00, 08:00, 16:00 UTC)
      const nowSec        = Math.floor(Date.now() / 1000)
      const intervalSec   = 8 * 3600
      const nextFundingAt = Math.ceil(nowSec / intervalSec) * intervalSec

      return reply.type('application/json').send(JSON.stringify({
        pairId,
        rate:         rateScaled.toString(),
        markPrice:    funding.markPrice.toString(),
        indexPrice:   funding.indexPrice.toString(),
        nextFundingAt,
        timestamp:    funding.timestamp,
      }))
    })
  }
}
