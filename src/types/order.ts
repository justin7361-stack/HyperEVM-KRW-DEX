import type { Address, Hex } from 'viem'

// ── Order classification ────────────────────────────────────────────────────
export type OrderType    = 'limit' | 'market'
// GTC  = Good Till Cancelled (default) — 취소할 때까지 유지
// IOC  = Immediate Or Cancel           — 즉시 채울 수 있는 만큼 채우고 잔량 취소
// FOK  = Fill Or Kill                  — 전량 즉시 체결 아니면 전부 취소
// GTT  = Good Till Time                — goodTillTime 까지 유지
// POST_ONLY = 체결되면 취소 (maker 전용)
export type TimeInForce  = 'GTC' | 'IOC' | 'FOK' | 'GTT' | 'POST_ONLY'
export type ConditionType = 'stop_loss' | 'take_profit'
export type MarginMode   = 'cross' | 'isolated'

// ── Core order ──────────────────────────────────────────────────────────────
export interface Order {
  maker:      Address
  taker:      Address     // '0x0000...0000' = any taker
  baseToken:  Address
  quoteToken: Address
  price:      bigint      // quoteToken per baseToken (18 decimals); 0n for market orders
  amount:     bigint      // baseToken quantity (18 decimals)
  isBuy:      boolean
  nonce:      bigint
  expiry:     bigint      // unix timestamp seconds (hard deadline — always enforced)
  proof?:     Hex         // reserved for future ZKP

  // ── Order type / time-in-force ──────────────────────────────────────────
  orderType?:    OrderType      // omitted = 'limit'
  timeInForce?:  TimeInForce    // omitted = 'GTC'; market orders default to 'IOC'

  // ── Conditional orders (stop-loss / take-profit) ────────────────────────
  conditionType?: ConditionType // set → order lives in ConditionalOrderEngine until triggered
  triggerPrice?:  bigint        // required when conditionType is set

  // ── Position management ─────────────────────────────────────────────────
  reduceOnly?:  boolean         // reject if no matching open position
  marginMode?:  MarginMode      // 'cross' | 'isolated' (Perp only)

  // ── Client-side dedup / tracking ────────────────────────────────────────
  clientOrderId?: string        // trader-supplied ID; unique per (maker, status=open)

  // ── GTT expiry ──────────────────────────────────────────────────────────
  goodTillTime?:  bigint        // unix timestamp; used when timeInForce === 'GTT'
}

// ── Stored in orderbook ─────────────────────────────────────────────────────
export interface StoredOrder extends Order {
  id:           string    // server-generated uuid
  signature:    Hex
  submittedAt:  number    // Date.now()
  filledAmount: bigint
  status:       'open' | 'partial' | 'filled' | 'cancelled' | 'expired'
  makerIp:      string    // for GeoBlock plugin
}

// ── Match result ────────────────────────────────────────────────────────────
export interface MatchResult {
  makerOrder: StoredOrder
  takerOrder: StoredOrder
  fillAmount: bigint
  price:      bigint      // execution price
  matchedAt:  number
  makerFee?:  bigint      // quoteToken units, 18 decimals; positive = fee charged, negative = rebate
  takerFee?:  bigint      // quoteToken units, 18 decimals; always positive (charged)
}

// ── Orderbook depth ─────────────────────────────────────────────────────────
export interface PriceLevel {
  price:      bigint
  amount:     bigint
  orderCount: number
}

export interface OrderBookDepth {
  pairId:    string
  bids:      PriceLevel[]   // price DESC
  asks:      PriceLevel[]   // price ASC
  timestamp: number
}

// ── Trade record ─────────────────────────────────────────────────────────────
export interface TradeRecord {
  id:           string
  pairId:       string
  price:        bigint
  amount:       bigint
  isBuyerMaker: boolean
  tradedAt:     number
  txHash?:      Hex
}

// ── Candle (OHLCV) ──────────────────────────────────────────────────────────
export type CandleResolution = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

export interface Candle {
  pairId:     string
  resolution: CandleResolution
  openTime:   number    // ms since epoch (start of bucket)
  open:       bigint
  high:       bigint
  low:        bigint
  close:      bigint
  volume:     bigint    // baseToken volume
  tradeCount: number
}

// ── Fee tier ─────────────────────────────────────────────────────────────────
export interface FeeTier {
  minVolume30d: bigint   // baseToken units
  makerBps:    number    // basis points (0 = free)
  takerBps:    number
}

// ── Funding rate ─────────────────────────────────────────────────────────────
export interface FundingRate {
  pairId:    string
  rate:      number     // e.g. 0.0001 = 0.01% per 8h
  markPrice: bigint
  indexPrice: bigint
  timestamp: number
}

// ── Margin ───────────────────────────────────────────────────────────────────
export interface MarginPosition {
  maker:       Address
  pairId:      string
  size:        bigint    // baseToken, positive=long, negative=short
  entryPrice:  bigint
  margin:      bigint    // quoteToken collateral for this position
  marginMode:  MarginMode
}
