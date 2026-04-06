import { createPublicClient, http, fallback, getContract } from 'viem'
import type { PublicClient } from 'viem'
import type { Config } from '../config/config.js'
import { ORDER_SETTLEMENT_ABI, PAIR_REGISTRY_ABI, ORACLE_ADMIN_ABI } from './abis.js'

export function createClients(config: Config) {
  // O-4: fallback transport — primary RPC (e.g. Alchemy) → public RPC
  // Reference: viem fallback transport (dYdX v4 indexer pattern)
  const transports = config.rpcUrlFallback
    ? [http(config.rpcUrl), http(config.rpcUrlFallback)]
    : [http(config.rpcUrl)]

  // Cast to PublicClient so the inferred fallback-transport type doesn't leak into
  // the function signature (TS2742: cannot be named without reference to viem internals).
  const publicClient = createPublicClient({
    transport: fallback(transports, {
      rank: {
        interval:    60_000,  // re-rank every 60s
        weights: { latency: 0.3, stability: 0.7 },
      },
    }),
  }) as PublicClient

  const orderSettlement = getContract({
    address: config.orderSettlementAddress,
    abi: ORDER_SETTLEMENT_ABI,
    client: publicClient,
  })

  const pairRegistry = getContract({
    address: config.pairRegistryAddress,
    abi: PAIR_REGISTRY_ABI,
    client: publicClient,
  })

  const oracleAdmin = getContract({
    address: config.oracleAdminAddress,
    abi: ORACLE_ADMIN_ABI,
    client: publicClient,
  })

  return { publicClient, orderSettlement, pairRegistry, oracleAdmin }
}

export type Clients = ReturnType<typeof createClients>
