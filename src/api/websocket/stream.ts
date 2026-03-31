import type { FastifyInstance } from 'fastify'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { MatchResult } from '../../types/order.js'
import type { TradeStore } from '../routes/trades.js'
import type { WebSocket } from '@fastify/websocket'
import type { FastifyRequest } from 'fastify'

function serializeMatch(match: MatchResult) {
  return {
    price:    match.price.toString(),
    amount:   match.fillAmount.toString(),
    maker:    match.makerOrder.maker,
    taker:    match.takerOrder.maker,
    tradedAt: match.matchedAt,
  }
}

export function streamRoutes(matching: MatchingEngine, tradeStore: TradeStore) {
  return async function (fastify: FastifyInstance) {
    fastify.get('/stream', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
      // Client specifies pair via query param: /stream?pair=BASE/QUOTE
      const pairId = (req.query as Record<string, string>).pair
      if (!pairId) {
        socket.send(JSON.stringify({ type: 'error', message: 'pair query param required' }))
        socket.close()
        return
      }

      // Send orderbook snapshot immediately on connect
      matching.getDepth(pairId, 20).then(depth => {
        if (socket.readyState !== 1) return
        socket.send(JSON.stringify({
          type: 'orderbook.snapshot',
          data: {
            pairId:    depth.pairId,
            timestamp: depth.timestamp,
            bids: depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
            asks: depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
          },
        }))
      })

      // Stream live matches as trade events + order status updates
      const onMatched = (match: MatchResult) => {
        const matchPairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
        if (matchPairId !== pairId) return
        if (socket.readyState !== 1 /* OPEN */) return

        socket.send(JSON.stringify({
          type: 'trades.recent',
          data: serializeMatch(match),
        }))

        socket.send(JSON.stringify({
          type: 'order.status',
          data: {
            orderId:      match.makerOrder.id,
            maker:        match.makerOrder.maker,
            status:       match.makerOrder.status,
            filledAmount: match.makerOrder.filledAmount.toString(),
          },
        }))
        socket.send(JSON.stringify({
          type: 'order.status',
          data: {
            orderId:      match.takerOrder.id,
            maker:        match.takerOrder.maker,
            status:       match.takerOrder.status,
            filledAmount: match.takerOrder.filledAmount.toString(),
          },
        }))

        // Push updated depth after each match
        matching.getDepth(pairId, 20).then(depth => {
          if (socket.readyState !== 1) return
          socket.send(JSON.stringify({
            type: 'orderbook.update',
            data: {
              bids:      depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
              asks:      depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
              timestamp: depth.timestamp,
            },
          }))
        })
      }

      matching.on('matched', onMatched)

      // --- Heartbeat ---
      const PING_INTERVAL_MS = 30_000
      const PONG_TIMEOUT_MS  = 10_000

      let pongTimer: ReturnType<typeof setTimeout> | null = null

      const pingInterval = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return
        socket.send(JSON.stringify({ type: 'ping', ts: Date.now() }))
        pongTimer = setTimeout(() => {
          socket.terminate()  // force-close if no pong received within 10s
        }, PONG_TIMEOUT_MS)
      }, PING_INTERVAL_MS)

      socket.on('message', (raw: Buffer) => {
        let msg: { type?: string }
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.type === 'pong') {
          if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
        }
      })

      socket.on('close', () => {
        matching.off('matched', onMatched)
        clearInterval(pingInterval)
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
      })
    })
  }
}
