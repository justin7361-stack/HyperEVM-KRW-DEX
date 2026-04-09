import 'dotenv/config'
import { loadConfig } from './config/config.js'
import { createClients } from './chain/contracts.js'
import { createOperatorWallet } from './chain/wallet.js'
import { createVaultClient } from './chain/vaultClient.js'
import { EIP712Verifier } from './verification/EIP712Verifier.js'
import { AgentWalletStore } from './verification/AgentWalletStore.js'
import { AgentAwareVerifier } from './verification/AgentAwareVerifier.js'
import { PolicyEngine } from './compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from './compliance/plugins/BasicBlocklistPlugin.js'
import { GeoBlockPlugin } from './compliance/plugins/GeoBlockPlugin.js'
import { OFACPlugin } from './compliance/plugins/OFACPlugin.js'
import { auditLog } from './audit/AuditLog.js'
import { createDatabase } from './db/database.js'
import { createPubSub } from './pubsub/RedisPubSub.js'
import { MemoryOrderBookStore } from './core/orderbook/MemoryOrderBookStore.js'
import { MatchingEngine } from './core/matching/MatchingEngine.js'
import { SettlementWorker } from './core/settlement/SettlementWorker.js'
import { settleBatch } from './core/settlement/settleBatch.js'
import { ChainWatcher } from './core/watcher/ChainWatcher.js'
import { TradeStore } from './api/routes/trades.js'
import { buildServer } from './api/server.js'
import { CandleStore } from './core/candles/CandleStore.js'
import { FeeEngine } from './core/fees/FeeEngine.js'
import { ConditionalOrderEngine } from './core/conditional/ConditionalOrderEngine.js'
import { PositionTracker } from './core/position/PositionTracker.js'
import { ExpiryWorker } from './core/expiry/ExpiryWorker.js'
import { TraderKeyStore } from './api/auth/traderAuth.js'
import { FundingRateEngine } from './core/funding/FundingRateEngine.js'
import { LiquidationEngine } from './core/liquidation/LiquidationEngine.js'
import { MarkPriceOracle }   from './core/oracle/MarkPriceOracle.js'
import { InsuranceFund }     from './core/insurance/InsuranceFund.js'
import { InsuranceFundSyncer } from './core/insurance/InsuranceFundSyncer.js'
import { MarginAccount }     from './margin/MarginAccount.js'
import { CircuitBreaker }    from './core/matching/CircuitBreaker.js'
import { WalletRateLimiter } from './core/matching/WalletRateLimiter.js'
import { CancelAfterManager } from './core/matching/CancelAfterManager.js'
import { keccak256, encodePacked } from 'viem'
import { settleFundingOnChain } from './chain/settleFundingOnChain.js'
import { submitOrderbookRoot } from './chain/submitOrderbookRoot.js'

const config = loadConfig()

const vault = createVaultClient(config)
if (vault) {
  console.log('[Vault] AppRole configured — operator key loaded from Vault')
} else {
  console.log('[Vault] No Vault config — using OPERATOR_PRIVATE_KEY env var (testnet/dev)')
}

// O-1: PostgreSQL persistence (no-op NullDatabase if DATABASE_URL not set)
const db = await createDatabase(config.databaseUrl)

// O-2: Redis pub/sub (LocalPubSub EventEmitter fallback if REDIS_URL not set)
const pubsub = await createPubSub(config.redisUrl)

const { publicClient, pairRegistry } = createClients(config)
const { walletClient } = await createOperatorWallet(config, vault)

const domain = {
  name: 'KRW DEX' as const,
  version: '1' as const,
  chainId: BigInt(config.chainId),
  verifyingContract: config.orderSettlementAddress,
}

const agentWalletStore = new AgentWalletStore()
const verifier  = new AgentAwareVerifier(new EIP712Verifier(domain), agentWalletStore, domain)
const policy    = new PolicyEngine()
const store     = new MemoryOrderBookStore()
const trades    = new TradeStore()
const feeEngine = new FeeEngine()

// PositionTracker must be created before MatchingEngine so it can be
// passed as positionReader for reduce-only order validation (G-7).
const positionTracker = new PositionTracker()
const matching  = new MatchingEngine(store, feeEngine, positionTracker)

const blocklist = new BasicBlocklistPlugin(new Set())
policy.register(blocklist)
policy.register(new GeoBlockPlugin(new Set(config.blockedCountries)))
// O-7: OFAC sanctions screening (two-layer: local SDN set + optional Chainalysis API)
policy.register(new OFACPlugin({ chainalysisApiKey: config.chainalysisApiKey }))

const candleStore = new CandleStore()
const conditionalEngine = new ConditionalOrderEngine(
  (order, pairId) => matching.submitOrder(order, pairId),
)
const expiryWorker = new ExpiryWorker(store)
const traderKeyStore = new TraderKeyStore()

// ── Per-wallet rate limiter ──────────────────────────────────────────────────
const walletRateLimiter = new WalletRateLimiter({
  maxRequests: config.walletRateLimitMax,
  windowMs:    config.walletRateLimitWindowMs,
})

// ── Dead Man's Switch (S-1-1) ───────────────────────────────────────────────
// cancelAllFn: cancel all open/partial orders for a given maker
const cancelAfterManager = new CancelAfterManager(async (maker: string) => {
  const orders = await store.getOrdersByMaker(maker)
  const targets = orders.filter(o => o.status === 'open' || o.status === 'partial')
  await Promise.all(targets.map(o => store.updateOrder(o.id, { status: 'cancelled' })))
  return targets.length
})

// ── Circuit Breaker ─────────────────────────────────────────────────────────
const circuitBreaker = new CircuitBreaker({
  priceBandPct: config.circuitBreakerPriceBandPct,
  windowMs:     config.circuitBreakerWindowMs,
})

circuitBreaker.on('halted', (info: { pairId: string; reason: string; haltedAt: number }) => {
  console.warn(`[CircuitBreaker] HALTED ${info.pairId}: ${info.reason} at ${new Date(info.haltedAt).toISOString()}`)
})
circuitBreaker.on('resumed', (info: { pairId: string; resumedAt: number }) => {
  console.log(`[CircuitBreaker] RESUMED ${info.pairId} at ${new Date(info.resumedAt).toISOString()}`)
})

// ── Margin account ──────────────────────────────────────────────────────────
// IMP-8: inject positionTracker so MarginAccount reads positions from the single source of truth
const marginAccount  = new MarginAccount(positionTracker)

// ── Perp engines ────────────────────────────────────────────────────────────
const markOracle     = new MarkPriceOracle()
const insuranceFund  = new InsuranceFund()
const fundingEngine  = new FundingRateEngine()
const liquidationEngine = new LiquidationEngine(
  markOracle,
  (order, pairId) => matching.submitOrder(order, pairId),
  250n,           // maintenanceMarginBps = 2.5%
  insuranceFund,
)

insuranceFund.on('adl_needed', (pairId: string, shortfall: bigint) => {
  console.warn(`[ADL] Insurance fund exhausted for ${pairId}, shortfall: ${shortfall}`)
})

liquidationEngine.on('liquidation', (event) => {
  console.log(`[Liquidation] ${event.position.maker} on ${event.position.pairId} — ${event.reason}`)
})

// N-3: Wire funding payment events to on-chain settleFunding().
// FUNDING_RESERVE_ADDRESS is the protocol reserve that funds outgoing payments.
// If absent (e.g. testnet/dev), payments are logged only.
fundingEngine.on('payment', (p: import('./core/funding/FundingRateEngine.js').FundingPayment) => {
  console.log(`[Funding] payment maker=${p.maker} pair=${p.pairId} amount=${p.amount} rate=${p.rate}`)
  if (config.fundingReserveAddress) {
    void settleFundingOnChain(
      walletClient,
      config.orderSettlementAddress,
      p,
      config.fundingReserveAddress as `0x${string}`,
    ).catch(err => console.error('[Funding] on-chain settlement error:', err))
  }
})

const worker = new SettlementWorker({
  batchSize:      config.batchSize,
  batchTimeoutMs: config.batchTimeoutMs,
  settle: (batch) => settleBatch(walletClient as any, config.orderSettlementAddress, batch),
})

matching.on('matched', (match) => {
  const pairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
  const tradeRecord = {
    id:           `${match.makerOrder.id}-${match.takerOrder.id}`,
    pairId,
    price:        match.price,
    amount:       match.fillAmount,
    isBuyerMaker: match.makerOrder.isBuy,
    tradedAt:     match.matchedAt,
  }
  worker.enqueue(match)
  positionTracker.onMatch(pairId, match)
  candleStore.onTrade(pairId, tradeRecord)
  trades.add(pairId, tradeRecord)
  // O-1: Persist trade to PostgreSQL (no-op if DATABASE_URL not set)
  void db.saveTrade(tradeRecord)
  // O-7: Audit trail
  auditLog.orderMatched(match.makerOrder.maker, match.takerOrder.maker, match.makerOrder.id, pairId, match.fillAmount, match.price)
  // O-2: Broadcast trade event via pub/sub (Redis or local EventEmitter)
  void pubsub.publish('trade', pairId, {
    pairId,
    price:        match.price.toString(),
    amount:       match.fillAmount.toString(),
    isBuyerMaker: match.makerOrder.isBuy,
    tradedAt:     match.matchedAt,
  })
})

matching.on('price', (pairId: string, price: bigint) => {
  void conditionalEngine.onPrice(pairId, price)
  markOracle.onTrade(pairId, { price, tradedAt: Date.now() })
  // Feed execution price to circuit breaker for auto-trip detection
  circuitBreaker.recordPrice(pairId, price)
})

worker.on('settled', (_batch, txHash) => console.log('Settled:', txHash))
worker.on('error',   (_batch, err)    => console.error('Settlement error:', err))

const watcher = new ChainWatcher(publicClient, config.orderSettlementAddress, store)
watcher.start()

// ── PairId resolver: keccak256(baseToken+quoteToken) bytes32 → off-chain pairId string (G-9)
// Reads all registered pairs from PairRegistry at startup, then starts
// InsuranceFundSyncer and FundingRateEngine for each active pair.
const pairIdMap = new Map<string, string>()
try {
  const onChainPairIds = await pairRegistry.read.getAllPairIds() as `0x${string}`[]
  for (const pid of onChainPairIds) {
    const pairRaw = await pairRegistry.read.pairs([pid]) as unknown as readonly [`0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, boolean]
    const pair = { baseToken: pairRaw[0], quoteToken: pairRaw[1], active: pairRaw[6] }
    // On-chain pairId matches OrderSettlement: keccak256(abi.encodePacked(base, quote))
    const onChainId = keccak256(encodePacked(['address', 'address'], [pair.baseToken, pair.quoteToken]))
    // Off-chain pairId format: "0xBASE/0xQUOTE"
    const offChainId = `${pair.baseToken}/${pair.quoteToken}`
    pairIdMap.set(onChainId.toLowerCase(), offChainId)

    // Start funding rate engine for each active pair (G-5/fix)
    if (pair.active) {
      fundingEngine.startPair(
        offChainId,
        () => positionTracker.getAll().filter(p => p.pairId === offChainId),
        () => markOracle.getMarkPrice(offChainId),
        () => markOracle.getIndexPrice(offChainId),
      )
    }
  }
  console.log(`[Startup] Loaded ${pairIdMap.size} pair(s) from PairRegistry`)
} catch (err) {
  console.warn('[Startup] Could not load pairs from PairRegistry (contract not deployed yet?)', err)
}

// InsuranceFundSyncer: watches LiquidationFeeRouted on-chain → deposits to in-memory fund (G-9)
const insuranceSyncer = new InsuranceFundSyncer(
  publicClient,
  config.orderSettlementAddress,
  insuranceFund,
  (id) => pairIdMap.get(id.toLowerCase()),
)
insuranceSyncer.on('synced', ({ pairId, amount }: { pairId: string; amount: bigint }) => {
  console.log(`[InsuranceFund] Synced ${amount} for ${pairId}`)
})
insuranceSyncer.on('unknown', ({ onChainPairId }: { onChainPairId: string }) => {
  console.warn(`[InsuranceFund] Unknown pairId: ${onChainPairId}`)
})
insuranceSyncer.on('error', (err: unknown) => {
  console.error('[InsuranceFund] Syncer error:', err)
})
insuranceSyncer.start()

// Check positions every 30 seconds
const liquidationInterval = setInterval(() => {
  const positions = positionTracker.getAll()
  void liquidationEngine.checkPositions(positions)
}, 30_000)

expiryWorker.start()

// S-2-1: Orderbook state root submission every 5 minutes (Lighter pattern).
// Iterates over all known off-chain pairIds (populated from PairRegistry at startup).
// Config: ORDERBOOK_ROOT_INTERVAL_MS (default 300000 = 5 min). Set 0 to disable.
const orderbookRootIntervalMs = parseInt(process.env['ORDERBOOK_ROOT_INTERVAL_MS'] ?? '300000', 10)
const orderbookRootInterval = orderbookRootIntervalMs > 0
  ? setInterval(() => {
      const allOrders = (store as import('./core/orderbook/MemoryOrderBookStore.js').MemoryOrderBookStore).getAllOpenOrders?.() ?? []
      for (const offChainPairId of pairIdMap.values()) {
        void submitOrderbookRoot(walletClient as any, config.oracleAdminAddress, allOrders, offChainPairId)
          .catch(err => console.error('[OrderbookRoot] interval error:', err))
      }
    }, orderbookRootIntervalMs)
  : null

const server = await buildServer({
  config, verifier, policy, matching, store, trades, pairRegistry,
  worker, blocklist, candleStore,
  conditionalEngine, positionTracker, traderKeyStore,
  marginAccount,
  fundingEngine,
  getMarkPrice:  (pair: string) => markOracle.getMarkPrice(pair),
  getIndexPrice: (pair: string) => markOracle.getIndexPrice(pair),
  db,
  pubsub,
  circuitBreaker,
  walletRateLimiter,
  cancelAfterManager,
  insuranceFund,
  liquidationEngine,
  agentWalletStore,
})

server.listen({ port: config.port, host: config.host }, (err) => {
  if (err) { console.error(err); process.exit(1) }
})

async function gracefulShutdown() {
  if (orderbookRootInterval) clearInterval(orderbookRootInterval)
  cancelAfterManager.destroy()
  walletRateLimiter.destroy()
  expiryWorker.stop()
  fundingEngine.stopAll()
  insuranceSyncer.stop()
  clearInterval(liquidationInterval)
  watcher.stop()
  worker.stop()
  await server.close()
  // O-1/O-2: Close DB and pub/sub connections
  await db.close()
  await pubsub.close()
  process.exit(0)
}

// M-4: Handle both SIGTERM (Docker/Railway) and SIGINT (Ctrl-C / local dev)
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT',  gracefulShutdown)
