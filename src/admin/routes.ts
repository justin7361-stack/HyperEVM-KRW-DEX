import type { FastifyInstance } from 'fastify'
import type { Address } from 'viem'
import type { Config } from '../config/config.js'
import type { MatchingEngine } from '../core/matching/MatchingEngine.js'
import type { SettlementWorker } from '../core/settlement/SettlementWorker.js'
import type { IOrderBookStore } from '../core/orderbook/IOrderBookStore.js'
import type { BasicBlocklistPlugin } from '../compliance/plugins/BasicBlocklistPlugin.js'
import { createAdminAuth } from './auth.js'

export interface AdminDeps {
  config:    Config
  matching:  MatchingEngine
  worker:    SettlementWorker
  store:     IOrderBookStore
  blocklist: BasicBlocklistPlugin
}

export function adminRoutes(deps: AdminDeps) {
  return async function (fastify: FastifyInstance) {
    const auth = createAdminAuth(deps.config.adminApiKey)

    // Apply auth to all admin routes
    fastify.addHook('preHandler', auth)

    // GET /admin/stats — server status
    fastify.get('/admin/stats', async (_req, reply) => {
      const stats = {
        uptime:    process.uptime(),
        memoryMB:  Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        queueSize: (deps.worker as any).queue?.length ?? 0,
        timestamp: Date.now(),
      }
      return reply.send(stats)
    })

    // GET /admin/blocklist — list blocked addresses
    fastify.get('/admin/blocklist', async (_req, reply) => {
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      return reply.send({ blocked: [...blocked] })
    })

    // POST /admin/blocklist — add address to blocklist
    fastify.post<{ Body: { address: Address } }>('/admin/blocklist', async (req, reply) => {
      const { address } = req.body
      if (!address) return reply.status(400).send({ error: 'address required' })
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      blocked.add(address.toLowerCase() as Address)
      return reply.send({ added: address })
    })

    // DELETE /admin/blocklist/:address — remove from blocklist
    fastify.delete<{ Params: { address: string } }>('/admin/blocklist/:address', async (req, reply) => {
      const addr = req.params.address.toLowerCase() as Address
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      blocked.delete(addr)
      return reply.send({ removed: addr })
    })

    // POST /admin/pause — pause matching
    fastify.post('/admin/pause', async (_req, reply) => {
      (deps.matching as any)._paused = true
      return reply.send({ status: 'paused' })
    })

    // POST /admin/resume — resume matching
    fastify.post('/admin/resume', async (_req, reply) => {
      (deps.matching as any)._paused = false
      return reply.send({ status: 'resumed' })
    })
  }
}
