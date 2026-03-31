import type { FastifyInstance } from 'fastify'
import type { CandleStore } from '../../core/candles/CandleStore.js'
import type { CandleResolution } from '../../types/order.js'

const VALID_RESOLUTIONS = new Set<CandleResolution>(['1m','5m','15m','1h','4h','1d'])

export function candlesRoutes(candleStore: CandleStore) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{
      Params: { pair: string }
      Querystring: { resolution?: string; start?: string; end?: string }
    }>('/candles/:pair', async (req, reply) => {
      const pairId     = decodeURIComponent(req.params.pair)
      const resolution = (req.query.resolution ?? '1m') as CandleResolution
      const end        = req.query.end   ? Number(req.query.end)   : Date.now()
      const start      = req.query.start ? Number(req.query.start) : end - 24 * 3600 * 1000

      if (!VALID_RESOLUTIONS.has(resolution)) {
        return reply.status(400).send({ error: `resolution must be one of: ${[...VALID_RESOLUTIONS].join(', ')}` })
      }

      const candles = candleStore.get(pairId, resolution, start, end)
      return reply.send({
        candles: candles.map(c => ({
          ...c,
          open:   c.open.toString(),
          high:   c.high.toString(),
          low:    c.low.toString(),
          close:  c.close.toString(),
          volume: c.volume.toString(),
        })),
      })
    })
  }
}
