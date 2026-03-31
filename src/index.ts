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
const matching  = new MatchingEngine(store)

policy.register(new BasicBlocklistPlugin(new Set()))
policy.register(new GeoBlockPlugin(new Set(config.blockedCountries)))

const worker = new SettlementWorker({
  batchSize:      config.batchSize,
  batchTimeoutMs: config.batchTimeoutMs,
  settle: (batch) => settleBatch(walletClient as any, config.orderSettlementAddress, batch),
})

matching.on('matched', (match) => {
  worker.enqueue(match)
  const pairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
  trades.add(pairId, {
    id:           `${match.makerOrder.id}-${match.takerOrder.id}`,
    pairId,
    price:        match.price,
    amount:       match.fillAmount,
    isBuyerMaker: match.makerOrder.isBuy,
    tradedAt:     match.matchedAt,
  })
})

worker.on('settled', (_batch, txHash) => console.log('Settled:', txHash))
worker.on('error',   (_batch, err)    => console.error('Settlement error:', err))

const watcher = new ChainWatcher(publicClient, config.orderSettlementAddress, store)
watcher.start()

const server = buildServer({ config, verifier, policy, matching, store, trades, pairRegistry })

server.listen({ port: config.port, host: config.host }, (err) => {
  if (err) { console.error(err); process.exit(1) }
})

process.on('SIGTERM', async () => {
  worker.stop()
  watcher.stop()
  await server.close()
  process.exit(0)
})
