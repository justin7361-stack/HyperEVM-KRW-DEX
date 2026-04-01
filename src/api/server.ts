import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import type { Config } from '../config/config.js'
import type { Clients } from '../chain/contracts.js'
import type { IOrderVerifier } from '../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../core/orderbook/IOrderBookStore.js'
import type { SettlementWorker } from '../core/settlement/SettlementWorker.js'
import type { BasicBlocklistPlugin } from '../compliance/plugins/BasicBlocklistPlugin.js'
import { ordersRoutes } from './routes/orders.js'
import { ordersBatchRoutes } from './routes/ordersBatch.js'
import { orderbookRoutes } from './routes/orderbook.js'
import { tradesRoutes, TradeStore } from './routes/trades.js'
import { streamRoutes } from './websocket/stream.js'
import { adminRoutes } from '../admin/routes.js'
import { TraderKeyStore, createTraderAuth, apiKeyManagementRoutes } from './auth/traderAuth.js'
import { candlesRoutes } from './routes/candles.js'
import type { CandleStore } from '../core/candles/CandleStore.js'
import type { ConditionalOrderEngine } from '../core/conditional/ConditionalOrderEngine.js'
import type { PositionTracker } from '../core/position/PositionTracker.js'
import type { FundingRateEngine } from '../core/funding/FundingRateEngine.js'
import { fundingRoutes } from './routes/funding.js'
import { MarginAccount } from '../margin/MarginAccount.js'

export function buildServer(deps: {
  config:              Config
  verifier:            IOrderVerifier
  policy:              PolicyEngine
  matching:            MatchingEngine
  store:               IOrderBookStore
  trades:              TradeStore
  pairRegistry:        Clients['pairRegistry']
  worker?:             SettlementWorker
  blocklist?:          BasicBlocklistPlugin
  traderKeyStore?:     TraderKeyStore
  candleStore?:        CandleStore
  conditionalEngine?:  ConditionalOrderEngine
  positionTracker?:    PositionTracker
  fundingEngine?:      FundingRateEngine
  getMarkPrice?:       (pair: string) => bigint
  getIndexPrice?:      (pair: string) => bigint
  marginAccount?:      MarginAccount
}) {
  const { config, verifier, policy, matching, store, trades, pairRegistry, worker, blocklist } = deps
  const fastify = Fastify({ logger: true })

  fastify.register(fastifyCors,      { origin: true })
  fastify.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' })
  fastify.register(fastifyWebSocket)

  fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry, deps.marginAccount ?? new MarginAccount()))
  fastify.register(ordersBatchRoutes(verifier, policy, matching, pairRegistry))
  fastify.register(orderbookRoutes(matching))
  fastify.register(tradesRoutes(trades))
  fastify.register(streamRoutes(matching, trades))

  if (deps.candleStore) fastify.register(candlesRoutes(deps.candleStore))

  if (deps.fundingEngine && deps.getMarkPrice && deps.getIndexPrice) {
    fastify.register(fundingRoutes(deps.fundingEngine, deps.getMarkPrice, deps.getIndexPrice))
  }

  // Admin dashboard static files + admin API routes (optional in tests)
  if (worker && blocklist) {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    fastify.register(fastifyStatic, {
      root:   join(__dirname, '../../src/admin/public'),
      prefix: '/admin/ui',
    })
    fastify.register(adminRoutes({ config, matching, worker, store, blocklist }))
  }

  if (deps.traderKeyStore) {
    const auth = createTraderAuth(deps.traderKeyStore, true)
    fastify.addHook('preHandler', async (req, reply) => {
      if (['POST', 'PUT', 'DELETE'].includes(req.method) && req.url.startsWith('/orders')) {
        await auth(req, reply)
      }
    })
    fastify.register(apiKeyManagementRoutes(deps.traderKeyStore, deps.config.adminApiKey))
  }

  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

  return fastify
}
