import { createPublicClient, http, getContract } from 'viem'
import type { Config } from '../config/config.js'
import { ORDER_SETTLEMENT_ABI, PAIR_REGISTRY_ABI, ORACLE_ADMIN_ABI } from './abis.js'

export function createClients(config: Config) {
  const publicClient = createPublicClient({
    transport: http(config.rpcUrl),
  })

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
