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
    fastify.post<{ Body: HaltBody }>('/admin/halt', async (req, reply) => {
      const { pairId, reason = 'admin: manual halt' } = req.body
      if (!pairId) {
        return reply.status(400).send({ error: 'pairId required' })
      }
      circuitBreaker.halt(pairId, reason)
      return reply.send({ halted: true, pairId, reason })
    })

    // POST /admin/resume — resume trading for a pair
    fastify.post<{ Body: ResumeBody }>('/admin/resume', async (req, reply) => {
      const { pairId } = req.body
      if (!pairId) {
        return reply.status(400).send({ error: 'pairId required' })
      }
      circuitBreaker.resume(pairId)
      return reply.send({ resumed: true, pairId })
    })

    // GET /admin/halted — list all currently halted pairs
    fastify.get('/admin/halted', async (_req, reply) => {
      return reply.send({ halted: circuitBreaker.getHaltedPairs() })
    })
  }
}
