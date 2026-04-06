import type { FastifyInstance } from 'fastify'
import type { PositionTracker } from '../../core/position/PositionTracker.js'
import type { MarginAccount } from '../../margin/MarginAccount.js'
import type { MarkPriceOracle } from '../../core/oracle/MarkPriceOracle.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function positionsRoutes(
  positionTracker: PositionTracker,
  marginAccount:   MarginAccount,
  getMarkPrice?:   (pairId: string) => bigint,
) {
  return async function (fastify: FastifyInstance) {

    // GET /positions/:address — all positions for a maker
    fastify.get<{ Params: { address: string } }>('/positions/:address', {
      schema: {
        tags: ['positions'],
        summary: 'Get all positions for an address',
        params: { type: 'object', properties: { address: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              address:      { type: 'string' },
              totalBalance: { type: 'string' },
              freeMargin:   { type: 'string' },
              positions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    pairId:        { type: 'string' },
                    size:          { type: 'string', description: 'Positive=long, negative=short' },
                    margin:        { type: 'string' },
                    mode:          { type: 'string', enum: ['cross', 'isolated'] },
                    entryPrice:    { type: 'string' },
                    markPrice:     { type: 'string' },
                    unrealizedPnl: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    }, async (req, reply) => {
      const addr = req.params.address.toLowerCase()
      if (!ADDRESS_RE.test(req.params.address)) {
        return reply.status(400).send({ error: 'Invalid address' })
      }

      const allPositions = positionTracker.getAll()
      const makerPositions = allPositions.filter(
        p => p.maker.toLowerCase() === addr && p.size !== 0n,
      )

      const marginState = marginAccount.getState(req.params.address as `0x${string}`)

      const result = makerPositions.map(p => {
        const markPrice = getMarkPrice ? getMarkPrice(p.pairId) : 0n
        const absSize   = p.size < 0n ? -p.size : p.size
        const pnl       = p.size > 0n
          ? (markPrice - p.entryPrice) * absSize / (10n ** 18n)
          : (p.entryPrice - markPrice) * absSize / (10n ** 18n)
        return {
          maker:            p.maker,
          pairId:           p.pairId,
          size:             p.size.toString(),
          margin:           p.margin.toString(),
          mode:             p.mode,
          entryPrice:       p.entryPrice.toString(),
          markPrice:        markPrice.toString(),
          unrealizedPnl:    pnl.toString(),
        }
      })

      return reply.type('application/json').send(JSON.stringify({
        address:      req.params.address,
        totalBalance: marginState.totalBalance.toString(),
        freeMargin:   marginState.freeMargin.toString(),
        positions:    result,
      }))
    })
  }
}
