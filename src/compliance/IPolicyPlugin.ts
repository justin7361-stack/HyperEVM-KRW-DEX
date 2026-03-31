import type { Address } from 'viem'

export interface TradeContext {
  maker:      Address
  taker:      Address
  baseToken:  Address
  quoteToken: Address
  amount:     bigint
  price:      bigint
  makerIp:    string
}

export interface PolicyResult {
  allowed: boolean
  reason?: string
}

export interface IPolicyPlugin {
  name: string
  check(ctx: TradeContext): Promise<PolicyResult>
}
