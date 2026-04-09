/**
 * Agent Wallet API (S-3-2 — Hyperliquid pattern).
 *
 * Traders can delegate order-signing to an agent wallet:
 *   POST   /auth/agent-wallet           — approve an agent
 *   DELETE /auth/agent-wallet           — revoke current agent
 *   GET    /auth/agent-wallet/:trader   — get current agent
 */
import type { FastifyPluginCallback } from 'fastify'
import type { AgentWalletStore } from '../../verification/AgentWalletStore.js'

export function agentWalletRoutes(agentStore: AgentWalletStore): FastifyPluginCallback {
  return (fastify, _opts, done) => {

    // GET /auth/agent-wallet/:trader
    fastify.get<{ Params: { trader: string } }>('/auth/agent-wallet/:trader', {
      schema: {
        tags: ['orders'],
        summary: 'Get current agent wallet for a trader',
        params: {
          type: 'object',
          required: ['trader'],
          properties: {
            trader: { type: 'string', description: 'Trader address' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              trader: { type: 'string' },
              agent:  { type: 'string', nullable: true },
            },
          },
        },
      },
    }, async (req, _reply) => {
      const { trader } = req.params
      return {
        trader: trader.toLowerCase(),
        agent:  agentStore.get(trader) ?? null,
      }
    })

    // POST /auth/agent-wallet
    fastify.post('/auth/agent-wallet', {
      schema: {
        tags: ['orders'],
        summary: 'Approve an agent wallet to sign orders on behalf of trader',
        description: 'The agent can sign orders as if they were the trader. One agent per trader. Overwrites any existing agent.',
        body: {
          type: 'object',
          required: ['trader', 'agentAddress'],
          properties: {
            trader:       { type: 'string', description: 'Trader address (must match authenticated key)' },
            agentAddress: { type: 'string', description: 'Agent wallet address to approve' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              trader: { type: 'string' },
              agent:  { type: 'string' },
            },
          },
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    }, async (req, reply) => {
      const { trader, agentAddress } = req.body as { trader: string; agentAddress: string }

      if (!trader.startsWith('0x') || trader.length !== 42) {
        reply.code(400)
        return { error: 'Invalid trader address' }
      }
      if (!agentAddress.startsWith('0x') || agentAddress.length !== 42) {
        reply.code(400)
        return { error: 'Invalid agent address' }
      }
      if (trader.toLowerCase() === agentAddress.toLowerCase()) {
        reply.code(400)
        return { error: 'Agent cannot be the same as trader' }
      }

      agentStore.set(trader, agentAddress)
      return { trader: trader.toLowerCase(), agent: agentAddress.toLowerCase() }
    })

    // DELETE /auth/agent-wallet
    fastify.delete('/auth/agent-wallet', {
      schema: {
        tags: ['orders'],
        summary: 'Revoke agent wallet delegation',
        body: {
          type: 'object',
          required: ['trader'],
          properties: {
            trader: { type: 'string', description: 'Trader address' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              trader:  { type: 'string' },
              revoked: { type: 'boolean' },
            },
          },
        },
      },
    }, async (req, _reply) => {
      const { trader } = req.body as { trader: string }
      const revoked = agentStore.delete(trader)
      return { trader: trader.toLowerCase(), revoked }
    })

    done()
  }
}
