import type { FastifyInstance } from 'fastify'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { MatchResult } from '../../types/order.js'
import type { TradeStore } from '../routes/trades.js'
import type { WebSocket } from '@fastify/websocket'
import type { FastifyRequest } from 'fastify'
import type { FundingRateEngine } from '../../core/funding/FundingRateEngine.js'
import type { PositionTracker } from '../../core/position/PositionTracker.js'

const MARK_PRICE_INTERVAL_MS = 5_000
const FUNDING_INTERVAL_MS    = 30_000

function serializeMatch(match: MatchResult) {
  return {
    price:    match.price.toString(),
    amount:   match.fillAmount.toString(),
    maker:    match.makerOrder.maker,
    taker:    match.takerOrder.maker,
    tradedAt: match.matchedAt,
  }
}

export function streamRoutes(
  matching:         MatchingEngine,
  tradeStore:       TradeStore,
  getMarkPrice:     (pairId: string) => bigint,
  getIndexPrice:    (pairId: string) => bigint,
  fundingEngine?:   FundingRateEngine,
  positionTracker?: PositionTracker,
) {
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
        if (socket.readyState !== socket.OPEN) return
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

      // Send markprice.update immediately on connect
      if (socket.readyState === socket.OPEN) {
        const price = getMarkPrice(pairId)
        const index = getIndexPrice(pairId)
        socket.send(JSON.stringify({
          type: 'markprice.update',
          data: {
            pairId,
            markPrice:  price.toString(),
            indexPrice: index.toString(),
            ts: Date.now(),
          },
        }))
      }

      // Send funding.update immediately on connect
      if (fundingEngine && socket.readyState === socket.OPEN) {
        const markPrice  = getMarkPrice(pairId)
        const indexPrice = getIndexPrice(pairId)
        const funding    = fundingEngine.computeRate(markPrice, indexPrice)
        const rateScaled = BigInt(Math.round(funding.rate * 1e18))
        const nowSec     = Math.floor(Date.now() / 1000)
        const nextFundingAt = Math.ceil(nowSec / (8 * 3600)) * (8 * 3600)
        socket.send(JSON.stringify({
          type: 'funding.update',
          data: {
            pairId,
            rate:         rateScaled.toString(),
            markPrice:    markPrice.toString(),
            indexPrice:   indexPrice.toString(),
            nextFundingAt,
            ts: Date.now(),
          },
        }))
      }

      // Stream live matches as trade events + order status updates
      const onMatched = (match: MatchResult) => {
        const matchPairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
        if (matchPairId !== pairId) return
        if (socket.readyState !== socket.OPEN) return

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
          if (socket.readyState !== socket.OPEN) return
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

      // ── Position updates ─────────────────────────────────────────────────────
      const onPositionUpdated = (pos: {
        maker: string; pairId: string; size: string; margin: string;
        mode: string; entryPrice: string;
      }) => {
        if (pos.pairId !== pairId && !pos.pairId.includes(pairId) && !pairId.includes(pos.pairId)) return
        if (socket.readyState !== socket.OPEN) return
        socket.send(JSON.stringify({
          type: 'position.update',
          data: pos,
        }))
      }

      if (positionTracker) {
        positionTracker.on('position.updated', onPositionUpdated)
      }

      // --- Mark price periodic push (every 5s) ---
      const markPriceInterval = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return
        const price = getMarkPrice(pairId)
        const index = getIndexPrice(pairId)
        socket.send(JSON.stringify({
          type: 'markprice.update',
          data: {
            pairId,
            markPrice:  price.toString(),
            indexPrice: index.toString(),
            ts: Date.now(),
          },
        }))
      }, MARK_PRICE_INTERVAL_MS)

      // --- Funding rate periodic push (every 30s) ---
      const fundingInterval = fundingEngine
        ? setInterval(() => {
            if (socket.readyState !== socket.OPEN) return
            const markPrice  = getMarkPrice(pairId)
            const indexPrice = getIndexPrice(pairId)
            const funding    = fundingEngine.computeRate(markPrice, indexPrice)
            const rateScaled = BigInt(Math.round(funding.rate * 1e18))
            const nowSec     = Math.floor(Date.now() / 1000)
            const nextFundingAt = Math.ceil(nowSec / (8 * 3600)) * (8 * 3600)
            socket.send(JSON.stringify({
              type: 'funding.update',
              data: {
                pairId,
                rate:         rateScaled.toString(),
                markPrice:    markPrice.toString(),
                indexPrice:   indexPrice.toString(),
                nextFundingAt,
                ts: Date.now(),
              },
            }))
          }, FUNDING_INTERVAL_MS)
        : null

      // --- Heartbeat ---
      const PING_INTERVAL_MS = 30_000
      const PONG_TIMEOUT_MS  = 10_000

      let pongTimer: ReturnType<typeof setTimeout> | null = null

      const pingInterval = setInterval(() => {
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
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
        if (positionTracker) positionTracker.off('position.updated', onPositionUpdated)
        clearInterval(markPriceInterval)
        if (fundingInterval) clearInterval(fundingInterval)
        clearInterval(pingInterval)
        if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
      })
    })
  }
}
