/**
 * Distributed Liquidator API (S-3-1 — Orderly pattern).
 *
 * External liquidators can:
 *   GET  /liquidatable-positions           — discover undercollateralized positions
 *   POST /liquidations                     — trigger liquidation and receive reward
 *
 * No auth required on GET (public data).
 * POST requires liquidatorAddress in body (reward tracking).
 */

import type { FastifyPluginCallback } from 'fastify'
import type { LiquidationEngine } from '../../core/liquidation/LiquidationEngine.js'
import type { PositionTracker } from '../../core/position/PositionTracker.js'

export function liquidationsRoutes(
  liquidationEngine: LiquidationEngine,
  positionTracker:   PositionTracker,
): FastifyPluginCallback {
  return (fastify, _opts, done) => {

    // GET /liquidatable-positions
    fastify.get('/liquidatable-positions', {
      schema: {
        tags: ['positions'],
        summary: 'List all liquidatable positions',
        description: 'Returns positions whose health ratio < 1.0 (margin below maintenance threshold). Public endpoint for external liquidators.',
        querystring: {
          type: 'object',
          properties: {
            pairId: { type: 'string', description: 'Filter by pair (e.g. 0xBASE/0xQUOTE)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              positions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    maker:       { type: 'string' },
                    pairId:      { type: 'string' },
                    size:        { type: 'string' },
                    margin:      { type: 'string' },
                    minMargin:   { type: 'string' },
                    markPrice:   { type: 'string' },
                    healthRatio: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    }, async (req, _reply) => {
      const { pairId } = req.query as { pairId?: string }
      let positions = positionTracker.getAll()
      if (pairId) positions = positions.filter(p => p.pairId === pairId)

      const liquidatable = liquidationEngine.getLiquidatablePositions(positions)
      return {
        positions: liquidatable.map(p => ({
          maker:       p.maker,
          pairId:      p.pairId,
          size:        p.size.toString(),
          margin:      p.margin.toString(),
          minMargin:   p.minMargin.toString(),
          markPrice:   p.markPrice.toString(),
          healthRatio: p.healthRatio,
        })),
      }
    })

    // POST /liquidations
    fastify.post('/liquidations', {
      schema: {
        tags: ['positions'],
        summary: 'Trigger liquidation (external liquidator)',
        description: 'External liquidators submit a liquidation request for an undercollateralized position.',
        body: {
          type: 'object',
          required: ['maker', 'pairId', 'liquidatorAddress'],
          properties: {
            maker:             { type: 'string', description: 'Address of the position owner to liquidate' },
            pairId:            { type: 'string', description: 'Pair identifier (e.g. 0xBASE/0xQUOTE)' },
            liquidatorAddress: { type: 'string', description: 'Address of the liquidator (for reward tracking)' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              triggered: { type: 'boolean' },
              reason:    { type: 'string' },
            },
          },
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    }, async (req, reply) => {
      const { maker, pairId, liquidatorAddress } = req.body as {
        maker: string
        pairId: string
        liquidatorAddress: string
      }

      // Find the position
      const all = positionTracker.getAll()
      const pos = all.find(p =>
        p.maker.toLowerCase() === maker.toLowerCase() &&
        p.pairId === pairId,
      )

      if (!pos) {
        reply.code(404)
        return { error: `position not found: ${maker} / ${pairId}` }
      }

      const result = await liquidationEngine.triggerExternalLiquidation(pos, liquidatorAddress)
      return result
    })

    done()
  }
}
