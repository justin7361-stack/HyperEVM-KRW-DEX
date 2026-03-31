import 'dotenv/config'
import { loadConfig } from './config/config.js'
import { createClients } from './chain/contracts.js'
import { createOperatorWallet } from './chain/wallet.js'
import { EIP712Verifier } from './verification/EIP712Verifier.js'
import { PolicyEngine } from './compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from './compliance/plugins/BasicBlocklistPlugin.js'
import { GeoBlockPlugin } from './compliance/plugins/GeoBlockPlugin.js'
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

const config = loadConfig()
const { publicClient, pairRegistry } = createClients(config)
const { walletClient } = createOperatorWallet(config)

const domain = {
  name: 'KRW DEX' as const,
  version: '1' as const,
  chainId: BigInt(config.chainId),
  verifyingContract: config.orderSettlementAddress,
}

const verifier  = new EIP712Verifier(domain)
const policy    = new PolicyEngine()
const store     = new MemoryOrderBookStore()
const trades    = new TradeStore()
const feeEngine = new FeeEngine()
const matching  = new MatchingEngine(store, feeEngine)

const blocklist = new BasicBlocklistPlugin(new Set())
policy.register(blocklist)
policy.register(new GeoBlockPlugin(new Set(config.blockedCountries)))

const candleStore = new CandleStore()
const positionTracker = new PositionTracker()
const conditionalEngine = new ConditionalOrderEngine(
  (order, pairId) => matching.submitOrder(order, pairId),
)
const expiryWorker = new ExpiryWorker(store)
const traderKeyStore = new TraderKeyStore()

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
})

matching.on('price', (pairId: string, price: bigint) => {
  void conditionalEngine.onPrice(pairId, price)
  markOracle.onTrade(pairId, { price, tradedAt: Date.now() })
})

worker.on('settled', (_batch, txHash) => console.log('Settled:', txHash))
worker.on('error',   (_batch, err)    => console.error('Settlement error:', err))

const watcher = new ChainWatcher(publicClient, config.orderSettlementAddress, store)
watcher.start()

// Check positions every 30 seconds
const liquidationInterval = setInterval(() => {
  const positions = positionTracker.getAll()
  void liquidationEngine.checkPositions(positions)
}, 30_000)

expiryWorker.start()

const server = buildServer({
  config, verifier, policy, matching, store, trades, pairRegistry,
  worker, blocklist, candleStore,
  conditionalEngine, positionTracker, traderKeyStore,
})

server.listen({ port: config.port, host: config.host }, (err) => {
  if (err) { console.error(err); process.exit(1) }
})

process.on('SIGTERM', async () => {
  expiryWorker.stop()
  fundingEngine.stopAll()
  clearInterval(liquidationInterval)
  watcher.stop()
  worker.stop()
  await server.close()
  process.exit(0)
})
