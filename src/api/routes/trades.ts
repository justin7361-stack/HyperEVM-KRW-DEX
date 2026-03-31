import type { FastifyInstance } from 'fastify'
import type { TradeRecord } from '../../types/order.js'

// In-memory trade history (production: move to DB)
export class TradeStore {
  private readonly trades = new Map<string, TradeRecord[]>()

  add(pairId: string, trade: TradeRecord): void {
    const list = this.trades.get(pairId) ?? []
    list.unshift(trade)               // newest first
    if (list.length > 500) list.pop() // cap at 500
    this.trades.set(pairId, list)
  }

  get(pairId: string, limit = 50): TradeRecord[] {
    return (this.trades.get(pairId) ?? []).slice(0, limit)
  }
}

export function tradesRoutes(tradeStore: TradeStore) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/trades/:pair', async (req, reply) => {
      const pairId = decodeURIComponent(req.params.pair)
      const trades = tradeStore.get(pairId, 50)
      return reply.send({
        trades: trades.map(t => ({
          ...t,
          price:  t.price.toString(),
          amount: t.amount.toString(),
        })),
      })
    })
  }
}
