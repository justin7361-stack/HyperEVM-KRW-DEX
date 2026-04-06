import type { FastifyInstance } from 'fastify'
import type { MarginAccount } from '../../margin/MarginAccount.js'
import type { Address } from 'viem'

interface DepositBody  { maker: Address; amount: string }
interface WithdrawBody { maker: Address; amount: string }

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export function marginRoutes(marginAccount: MarginAccount) {
  return async function (fastify: FastifyInstance) {

    // POST /margin/deposit — credit in-memory margin balance
    // ⚠️ Testnet only: no on-chain verification. Production must verify on-chain collateral.
    fastify.post<{ Body: DepositBody }>('/margin/deposit', {
      schema: {
        tags: ['positions'],
        summary: 'Record a margin deposit (called by settlement contract callback)',
        body: {
          type: 'object',
          required: ['maker', 'amount'],
          properties: {
            maker:  { type: 'string' },
            amount: { type: 'string' },
          },
        },
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
      },
    }, async (req, reply) => {
      const { maker, amount } = req.body
      if (!maker || !ADDRESS_RE.test(maker)) {
        return reply.status(400).send({ error: 'Invalid maker address' })
      }
      let amountBn: bigint
      try { amountBn = BigInt(amount) } catch {
        return reply.status(400).send({ error: 'Invalid amount — must be bigint string' })
      }
      if (amountBn <= 0n) {
        return reply.status(400).send({ error: 'Amount must be positive' })
      }

      marginAccount.deposit(maker, amountBn)
      const state = marginAccount.getState(maker)
      return reply.status(201).send({
        maker,
        totalBalance: state.totalBalance.toString(),
        freeMargin:   state.freeMargin.toString(),
      })
    })

    // POST /margin/withdraw — debit in-memory margin balance
    fastify.post<{ Body: WithdrawBody }>('/margin/withdraw', async (req, reply) => {
      const { maker, amount } = req.body
      if (!maker || !ADDRESS_RE.test(maker)) {
        return reply.status(400).send({ error: 'Invalid maker address' })
      }
      let amountBn: bigint
      try { amountBn = BigInt(amount) } catch {
        return reply.status(400).send({ error: 'Invalid amount — must be bigint string' })
      }
      if (amountBn <= 0n) {
        return reply.status(400).send({ error: 'Amount must be positive' })
      }

      const ok = marginAccount.withdraw(maker, amountBn)
      if (!ok) {
        return reply.status(400).send({ error: 'Insufficient balance' })
      }
      const state = marginAccount.getState(maker)
      return reply.status(200).send({
        maker,
        totalBalance: state.totalBalance.toString(),
        freeMargin:   state.freeMargin.toString(),
      })
    })

    // GET /margin/:address — query margin account state
    fastify.get<{ Params: { address: string } }>('/margin/:address', {
      schema: {
        tags: ['positions'],
        summary: 'Get margin balance for an address',
        params: { type: 'object', properties: { address: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              address:      { type: 'string' },
              totalBalance: { type: 'string' },
              freeMargin:   { type: 'string' },
              usedMargin:   { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      const addr = req.params.address as Address
      if (!ADDRESS_RE.test(addr)) {
        return reply.status(400).send({ error: 'Invalid address' })
      }
      const state = marginAccount.getState(addr)
      return reply.type('application/json').send(JSON.stringify({
        maker:        state.maker,
        totalBalance: state.totalBalance.toString(),
        usedMargin:   state.usedMargin.toString(),
        freeMargin:   state.freeMargin.toString(),
        positions: state.positions.map(p => ({
          maker:  p.maker,
          pairId: p.pairId,
          size:   p.size.toString(),
          margin: p.margin.toString(),
          mode:   p.mode,
        })),
      }))
    })
  }
}
