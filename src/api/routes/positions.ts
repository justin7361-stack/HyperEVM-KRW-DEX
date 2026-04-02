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
    fastify.get<{ Params: { address: string } }>('/positions/:address', async (req, reply) => {
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
        const markPrice   = getMarkPrice ? getMarkPrice(p.pairId) : 0n
        // unrealizedPnl: size > 0 = long → (markPrice - entryPrice) * size / 1e18
        // For now we don't track entryPrice per-position, so we return 0
        // Full P&L tracking requires MarginAccount.updatePosition() to store entryPrice
        return {
          maker:            p.maker,
          pairId:           p.pairId,
          size:             p.size.toString(),
          margin:           p.margin.toString(),
          mode:             p.mode,
          markPrice:        markPrice.toString(),
          unrealizedPnl:    '0',   // TODO: track entryPrice in MarginAccount
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
