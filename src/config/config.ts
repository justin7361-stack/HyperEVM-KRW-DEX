import type { Address, Hex } from 'viem'
import { isAddress, isHex } from 'viem'

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

function parseIntOrThrow(val: string, name: string): number {
  const n = parseInt(val, 10)
  if (isNaN(n)) throw new Error(`${name} must be a valid integer, got: ${val}`)
  return n
}

function requireAddress(key: string): Address {
  const val = requireEnv(key)
  if (!isAddress(val)) throw new Error(`${key} must be a valid Ethereum address, got: ${val}`)
  return val as Address
}

function requireHex(key: string): Hex {
  const val = requireEnv(key)
  if (!isHex(val)) throw new Error(`${key} must be a valid hex string (0x...), got: ${val}`)
  return val as Hex
}

export interface Config {
  rpcUrl: string
  // O-4: optional secondary RPC for fallback transport (Alchemy → public RPC)
  rpcUrlFallback: string | undefined
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
  adminApiKey: string
  // O-1: PostgreSQL connection string (optional — skips persistence if absent)
  databaseUrl: string | undefined
  // O-2: Redis URL (optional — skips pub/sub if absent)
  redisUrl: string | undefined
  // O-7: Chainalysis API key for OFAC screening (optional)
  chainalysisApiKey: string | undefined
  // N-3: Protocol reserve address for funding payments (optional — skips on-chain settlement if absent)
  fundingReserveAddress: string | undefined
  // R-2: HashiCorp Vault (optional — leave blank for testnet/dev)
  vaultAddr?:     string
  vaultRoleId?:   string
  vaultSecretId?: string
  // Circuit breaker config (optional)
  circuitBreakerPriceBandPct: number  // default 10 (10%)
  circuitBreakerWindowMs:     number  // default 60_000 (1 minute)
}

export function loadConfig(): Config {
  return {
    rpcUrl:                  requireEnv('RPC_URL'),
    rpcUrlFallback:          process.env['RPC_URL_FALLBACK'],
    chainId:                 parseIntOrThrow(requireEnv('CHAIN_ID'), 'CHAIN_ID'),
    operatorPrivateKey:      requireHex('OPERATOR_PRIVATE_KEY'),
    orderSettlementAddress:  requireAddress('ORDER_SETTLEMENT_ADDRESS'),
    pairRegistryAddress:     requireAddress('PAIR_REGISTRY_ADDRESS'),
    oracleAdminAddress:      requireAddress('ORACLE_ADMIN_ADDRESS'),
    port:                    parseIntOrThrow(optionalEnv('PORT', '3000'), 'PORT'),
    host:                    optionalEnv('HOST', '0.0.0.0'),
    batchTimeoutMs:          parseIntOrThrow(optionalEnv('BATCH_TIMEOUT_MS', '1000'), 'BATCH_TIMEOUT_MS'),
    batchSize:               parseIntOrThrow(optionalEnv('BATCH_SIZE', '10'), 'BATCH_SIZE'),
    blockedCountries:        optionalEnv('BLOCKED_COUNTRIES', 'KP,IR,SY,CU').split(','),
    adminApiKey:             requireEnv('ADMIN_API_KEY'),
    databaseUrl:             process.env['DATABASE_URL'],
    redisUrl:                process.env['REDIS_URL'],
    chainalysisApiKey:       process.env['CHAINALYSIS_API_KEY'],
    fundingReserveAddress:   process.env['FUNDING_RESERVE_ADDRESS'],
    vaultAddr:               process.env['VAULT_ADDR'],
    vaultRoleId:             process.env['VAULT_ROLE_ID'],
    vaultSecretId:           process.env['VAULT_SECRET_ID'],
    circuitBreakerPriceBandPct: parseIntOrThrow(
      optionalEnv('CIRCUIT_BREAKER_PRICE_BAND_PCT', '10'), 'CIRCUIT_BREAKER_PRICE_BAND_PCT'
    ),
    circuitBreakerWindowMs: parseIntOrThrow(
      optionalEnv('CIRCUIT_BREAKER_WINDOW_MS', '60000'), 'CIRCUIT_BREAKER_WINDOW_MS'
    ),
  }
}
