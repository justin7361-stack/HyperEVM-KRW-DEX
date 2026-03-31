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
  }
}
