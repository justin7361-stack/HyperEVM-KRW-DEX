import type { FastifyInstance } from 'fastify'
import { createAdminAuth } from '../../admin/auth.js'
import type { CircuitBreaker } from '../../core/matching/CircuitBreaker.js'

interface HaltBody {
  pairId:  string
  reason?: string
}

interface ResumeBody {
  pairId: string
}

export function circuitBreakerAdminRoutes(
  circuitBreaker: CircuitBreaker,
  adminApiKey: string,
) {
  return async function (fastify: FastifyInstance) {
    const auth = createAdminAuth(adminApiKey)
    fastify.addHook('preHandler', auth)

    // POST /admin/halt — manually halt trading for a pair
    fastify.post<{ Body: HaltBody }>('/admin/halt', {
      schema: {
        tags: ['admin'],
        summary: 'Halt trading for a pair',
        security: [{ AdminKeyAuth: [] }],
        body: { type: 'object', required: ['pairId'], properties: { pairId: { type: 'string' }, reason: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { halted: { type: 'boolean' }, pairId: { type: 'string' } } } },
      },
    }, async (req, reply) => {
      const { pairId, reason = 'admin: manual halt' } = req.body
      if (!pairId) {
        return reply.status(400).send({ error: 'pairId required' })
      }
      circuitBreaker.halt(pairId, reason)
      return reply.send({ halted: true, pairId, reason })
    })

    // POST /admin/resume — resume trading for a pair
    fastify.post<{ Body: ResumeBody }>('/admin/resume', {
      schema: {
        tags: ['admin'],
        summary: 'Resume trading for a pair',
        security: [{ AdminKeyAuth: [] }],
        body: { type: 'object', required: ['pairId'], properties: { pairId: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { resumed: { type: 'boolean' }, pairId: { type: 'string' } } } },
      },
    }, async (req, reply) => {
      const { pairId } = req.body
      if (!pairId) {
        return reply.status(400).send({ error: 'pairId required' })
      }
      circuitBreaker.resume(pairId)
      return reply.send({ resumed: true, pairId })
    })

    // GET /admin/halted — list all currently halted pairs
    fastify.get('/admin/halted', {
      schema: {
        tags: ['admin'],
        summary: 'List all halted pairs',
        security: [{ AdminKeyAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              halted: { type: 'array', items: { type: 'object', properties: { pairId: { type: 'string' }, reason: { type: 'string' }, haltedAt: { type: 'integer' } } } },
            },
          },
        },
      },
    }, async (_req, reply) => {
      return reply.send({ halted: circuitBreaker.getHaltedPairs() })
    })
  }
}
