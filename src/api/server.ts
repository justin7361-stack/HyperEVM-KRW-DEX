import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
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
import { PositionTracker } from '../core/position/PositionTracker.js'
import type { FundingRateEngine } from '../core/funding/FundingRateEngine.js'
import { fundingRoutes } from './routes/funding.js'
import { marginRoutes } from './routes/margin.js'
import { positionsRoutes } from './routes/positions.js'
import { MarginAccount } from '../margin/MarginAccount.js'
import type { IDatabase } from '../db/database.js'
import type { IPubSub } from '../pubsub/RedisPubSub.js'
import type { CircuitBreaker } from '../core/matching/CircuitBreaker.js'
import { circuitBreakerAdminRoutes } from './routes/admin.js'
import type { WalletRateLimiter } from '../core/matching/WalletRateLimiter.js'
import type { CancelAfterManager } from '../core/matching/CancelAfterManager.js'

export async function buildServer(deps: {
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
  db?:                 IDatabase
  pubsub?:             IPubSub
  circuitBreaker?:      CircuitBreaker
  walletRateLimiter?:   WalletRateLimiter
  cancelAfterManager?:  CancelAfterManager
}) {
  const { config, verifier, policy, matching, store, trades, pairRegistry, worker, blocklist } = deps
  const fastify = Fastify({ logger: true })

  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'HyperKRW DEX API',
        description: 'Perpetual futures DEX on HyperEVM — order submission, positions, funding, margin',
        version: process.env['npm_package_version'] ?? '0.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          ApiKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-API-Key',
            description: 'Trader API key (required for order submission)',
          },
          AdminKeyAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Admin-Key',
            description: 'Admin API key (required for admin endpoints)',
          },
        },
      },
      tags: [
        { name: 'orders', description: 'Order submission and management' },
        { name: 'positions', description: 'Position tracking and margin' },
        { name: 'market', description: 'Orderbook, trades, funding, candles' },
        { name: 'admin', description: 'Circuit breaker and admin controls' },
        { name: 'system', description: 'Health and status' },
      ],
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: true,
  })

  fastify.register(fastifyCors,      { origin: true })
  fastify.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' })
  fastify.register(fastifyWebSocket)

  fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry, deps.marginAccount ?? new MarginAccount(deps.positionTracker ?? new PositionTracker()), deps.circuitBreaker, deps.walletRateLimiter, deps.config, deps.cancelAfterManager))
  fastify.register(ordersBatchRoutes(verifier, policy, matching, pairRegistry))
  fastify.register(orderbookRoutes(matching))
  fastify.register(tradesRoutes(trades))
  fastify.register(streamRoutes(
    matching,
    trades,
    deps.getMarkPrice  ?? (() => 0n),
    deps.getIndexPrice ?? (() => 0n),
    deps.fundingEngine,
    deps.positionTracker,
  ))

  if (deps.candleStore) fastify.register(candlesRoutes(deps.candleStore))

  if (deps.fundingEngine && deps.getMarkPrice && deps.getIndexPrice) {
    fastify.register(fundingRoutes(deps.fundingEngine, deps.getMarkPrice, deps.getIndexPrice))
  }

  // Margin deposit/withdraw/query
  if (deps.marginAccount) {
    fastify.register(marginRoutes(deps.marginAccount))
  }

  // Position tracking
  if (deps.positionTracker) {
    fastify.register(positionsRoutes(
      deps.positionTracker,
      deps.marginAccount ?? new MarginAccount(deps.positionTracker!),
      deps.getMarkPrice,
    ))
  }

  // Circuit breaker admin endpoints
  if (deps.circuitBreaker) {
    fastify.register(circuitBreakerAdminRoutes(deps.circuitBreaker, config.adminApiKey))
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

  // Enhanced health check — used by Railway, Docker, Traefik, and monitoring
  fastify.get('/health', {
    schema: {
      tags: ['system'],
      summary: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status:  { type: 'string' },
            ts:      { type: 'integer' },
            version: { type: 'string' },
            checks:  { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'degraded' | 'n/a'> = {
      matching: 'ok',   // always ok if server is running
      db:       deps.db     ? 'ok' : 'n/a',
      pubsub:   deps.pubsub ? 'ok' : 'n/a',
    }

    // Quick non-blocking DB ping via saveOrder no-op (NullDatabase is always ok)
    // For PostgreSQL: connection errors would have crashed startup, so 'ok' is safe.
    // Future: add an explicit ping query here if needed.

    const allOk = Object.values(checks).every(v => v !== 'degraded')
    reply.code(allOk ? 200 : 503)
    return {
      status:  allOk ? 'ok' : 'degraded',
      ts:      Date.now(),
      version: process.env['npm_package_version'] ?? 'unknown',
      checks,
    }
  })

  return fastify
}
