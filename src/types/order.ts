import type { Address, Hex } from 'viem'

export interface Order {
  maker: Address
  taker: Address          // '0x0000...0000' = any taker
  baseToken: Address
  quoteToken: Address
  price: bigint           // quoteToken per baseToken (18 decimals)
  amount: bigint          // baseToken quantity (18 decimals)
  isBuy: boolean
  nonce: bigint
  expiry: bigint          // unix timestamp seconds
  proof?: Hex             // reserved for future ZKP
}

export interface StoredOrder extends Order {
  id: string              // uuid
  signature: Hex
  submittedAt: number     // Date.now()
  filledAmount: bigint
  status: 'open' | 'partial' | 'filled' | 'cancelled' | 'expired'
  makerIp: string         // for GeoBlock plugin
}

export interface MatchResult {
  makerOrder: StoredOrder
  takerOrder: StoredOrder
  fillAmount: bigint
  price: bigint           // execution price (makerOrder.price)
  matchedAt: number       // Date.now()
}

export interface PriceLevel {
  price: bigint
  amount: bigint          // total available at this level
  orderCount: number
}

export interface OrderBookDepth {
  pairId: string
  bids: PriceLevel[]      // sorted price DESC
  asks: PriceLevel[]      // sorted price ASC
  timestamp: number
}

export interface TradeRecord {
  id: string
  pairId: string
  price: bigint
  amount: bigint
  isBuyerMaker: boolean
  tradedAt: number
  txHash?: Hex            // populated after on-chain settlement
}
