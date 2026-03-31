import type { Address, Hex } from 'viem'

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export interface Config {
  rpcUrl: string
  chainId: number
  operatorPrivateKey: Hex
  orderSettlementAddress: Address
  pairRegistryAddress: Address
  oracleAdminAddress: Address
  port: number
  host: string
  batchTimeoutMs: number
  batchSize: number
  blockedCountries: string[]
}

export function loadConfig(): Config {
  return {
    rpcUrl:                  requireEnv('RPC_URL'),
    chainId:                 parseInt(requireEnv('CHAIN_ID'), 10),
    operatorPrivateKey:      requireEnv('OPERATOR_PRIVATE_KEY') as Hex,
    orderSettlementAddress:  requireEnv('ORDER_SETTLEMENT_ADDRESS') as Address,
    pairRegistryAddress:     requireEnv('PAIR_REGISTRY_ADDRESS') as Address,
    oracleAdminAddress:      requireEnv('ORACLE_ADMIN_ADDRESS') as Address,
    port:                    parseInt(optionalEnv('PORT', '3000'), 10),
    host:                    optionalEnv('HOST', '0.0.0.0'),
    batchTimeoutMs:          parseInt(optionalEnv('BATCH_TIMEOUT_MS', '1000'), 10),
    batchSize:               parseInt(optionalEnv('BATCH_SIZE', '10'), 10),
    blockedCountries:        optionalEnv('BLOCKED_COUNTRIES', 'KP,IR,SY,CU').split(','),
  }
}
