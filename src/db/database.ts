/**
 * Database module — O-1: PostgreSQL persistence via postgres.js.
 *
 * Designed as an optional layer: if DATABASE_URL is not set, all operations
 * are no-ops (the server runs purely in-memory as before).
 *
 * Install: npm install postgres
 * Migrate: psql $DATABASE_URL -f src/db/schema.sql
 *
 * Reference: postgres.js (https://github.com/porsager/postgres) — zero-dep,
 * fastest Node.js PostgreSQL client, tagged template literals for safety.
 */

import type { StoredOrder, TradeRecord, MarginPosition } from '../types/order.js'

/** Narrow interface so the rest of the codebase never depends on postgres.js directly */
export interface IDatabase {
  // Orders
  saveOrder(order: StoredOrder, pairId: string): Promise<void>
  updateOrderStatus(orderId: string, status: StoredOrder['status'], filledAmount: bigint): Promise<void>

  // Trades
  saveTrade(trade: TradeRecord): Promise<void>

  // Positions
  savePosition(pos: MarginPosition): Promise<void>
  deletePosition(maker: string, pairId: string): Promise<void>

  // Candles — called from CandleStore after each trade
  upsertCandle(pairId: string, resolution: string, openTime: bigint, o: bigint, h: bigint, l: bigint, c: bigint, vol: bigint): Promise<void>

  // Audit
  logAudit(entry: {
    ts: number; action: string; maker: string;
    orderId?: string; pairId?: string; amount?: string;
    price?: string; ip?: string; reason?: string; txHash?: string;
  }): Promise<void>

  // Funding
  logFundingPayment(maker: string, pairId: string, amount: bigint, rate: number, settledAt: number, txHash?: string): Promise<void>

  close(): Promise<void>
}

/** No-op implementation used when DATABASE_URL is absent */
class NullDatabase implements IDatabase {
  async saveOrder():                Promise<void> {}
  async updateOrderStatus():        Promise<void> {}
  async saveTrade():                Promise<void> {}
  async savePosition():             Promise<void> {}
  async deletePosition():           Promise<void> {}
  async upsertCandle():             Promise<void> {}
  async logAudit():                 Promise<void> {}
  async logFundingPayment():        Promise<void> {}
  async close():                    Promise<void> {}
}

/**
 * Real PostgreSQL implementation via postgres.js.
 *
 * Loaded dynamically so the server starts even if postgres.js is not installed.
 * If postgres.js is missing, falls back to NullDatabase with a warning.
 */
class PostgresDatabase implements IDatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly sql: any

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(sql: any) {
    this.sql = sql
  }

  async saveOrder(order: StoredOrder, pairId: string): Promise<void> {
    const sql = this.sql
    await sql`
      INSERT INTO orders (
        id, maker, taker, base_token, quote_token, price, amount,
        is_buy, nonce, expiry, signature, submitted_at, filled_amount,
        status, maker_ip, order_type, reduce_only, leverage, margin_mode, pair_id
      ) VALUES (
        ${order.id}, ${order.maker.toLowerCase()}, ${order.taker.toLowerCase()},
        ${order.baseToken.toLowerCase()}, ${order.quoteToken.toLowerCase()},
        ${order.price.toString()}, ${order.amount.toString()},
        ${order.isBuy}, ${order.nonce.toString()}, ${order.expiry.toString()},
        ${order.signature}, ${order.submittedAt}, ${order.filledAmount.toString()},
        ${order.status}, ${order.makerIp ?? null}, ${order.orderType ?? 'limit'},
        ${order.reduceOnly ?? false}, ${(order.leverage ?? 1n).toString()},
        ${order.marginMode ?? null}, ${pairId}
      )
      ON CONFLICT (id) DO NOTHING
    `
  }

  async updateOrderStatus(orderId: string, status: StoredOrder['status'], filledAmount: bigint): Promise<void> {
    await this.sql`
      UPDATE orders SET status = ${status}, filled_amount = ${filledAmount.toString()}
      WHERE id = ${orderId}
    `
  }

  async saveTrade(trade: TradeRecord): Promise<void> {
    await this.sql`
      INSERT INTO trades (id, pair_id, price, amount, is_buyer_maker, traded_at)
      VALUES (
        ${trade.id}, ${trade.pairId}, ${trade.price.toString()},
        ${trade.amount.toString()}, ${trade.isBuyerMaker}, ${trade.tradedAt}
      )
      ON CONFLICT (id) DO NOTHING
    `
  }

  async savePosition(pos: MarginPosition): Promise<void> {
    await this.sql`
      INSERT INTO positions (maker, pair_id, size, margin, mode, updated_at)
      VALUES (
        ${pos.maker.toLowerCase()}, ${pos.pairId},
        ${pos.size.toString()}, ${pos.margin.toString()},
        ${pos.mode}, ${Date.now()}
      )
      ON CONFLICT (maker, pair_id) DO UPDATE
        SET size = EXCLUDED.size, margin = EXCLUDED.margin,
            mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at
    `
  }

  async deletePosition(maker: string, pairId: string): Promise<void> {
    await this.sql`DELETE FROM positions WHERE maker = ${maker.toLowerCase()} AND pair_id = ${pairId}`
  }

  async upsertCandle(pairId: string, resolution: string, openTime: bigint, o: bigint, h: bigint, l: bigint, c: bigint, vol: bigint): Promise<void> {
    await this.sql`
      INSERT INTO candles (pair_id, resolution, open_time, open, high, low, close, volume)
      VALUES (
        ${pairId}, ${resolution}, ${openTime.toString()},
        ${o.toString()}, ${h.toString()}, ${l.toString()}, ${c.toString()}, ${vol.toString()}
      )
      ON CONFLICT (pair_id, resolution, open_time) DO UPDATE
        SET high = GREATEST(candles.high::numeric, EXCLUDED.high::numeric)::text,
            low  = LEAST(candles.low::numeric,  EXCLUDED.low::numeric)::text,
            close = EXCLUDED.close,
            volume = (candles.volume::numeric + EXCLUDED.volume::numeric)::text
    `
  }

  async logAudit(entry: {
    ts: number; action: string; maker: string;
    orderId?: string; pairId?: string; amount?: string;
    price?: string; ip?: string; reason?: string; txHash?: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO audit_log (ts, action, maker, order_id, pair_id, amount, price, ip, reason, tx_hash)
      VALUES (
        ${entry.ts}, ${entry.action}, ${entry.maker.toLowerCase()},
        ${entry.orderId ?? null}, ${entry.pairId ?? null},
        ${entry.amount ?? null}, ${entry.price ?? null},
        ${entry.ip ?? null}, ${entry.reason ?? null}, ${entry.txHash ?? null}
      )
    `
  }

  async logFundingPayment(maker: string, pairId: string, amount: bigint, rate: number, settledAt: number, txHash?: string): Promise<void> {
    await this.sql`
      INSERT INTO funding_payments (maker, pair_id, amount, rate, settled_at, tx_hash)
      VALUES (
        ${maker.toLowerCase()}, ${pairId}, ${amount.toString()},
        ${rate}, ${settledAt}, ${txHash ?? null}
      )
    `
  }

  async close(): Promise<void> {
    await this.sql.end()
  }
}

/**
 * Create a database connection if DATABASE_URL is configured.
 * Falls back to NullDatabase (no-op) if absent or postgres.js is not installed.
 */
export async function createDatabase(databaseUrl: string | undefined): Promise<IDatabase> {
  if (!databaseUrl) {
    console.log('[DB] DATABASE_URL not set — running in-memory only (no persistence)')
    return new NullDatabase()
  }

  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional peer dependency; not installed until `npm install postgres`
    const { default: postgres } = await import('postgres') as { default: (url: string, opts: object) => unknown }
    const sql = postgres(databaseUrl, {
      max:        10,         // connection pool size
      idle_timeout: 30,       // close idle connections after 30s
      connect_timeout: 10,    // fail fast if DB is unreachable
    })
    console.log('[DB] PostgreSQL connected:', databaseUrl.replace(/:[^:@]*@/, ':***@'))
    return new PostgresDatabase(sql)
  } catch (err) {
    console.warn('[DB] postgres.js not installed — running in-memory only. Run: npm install postgres')
    console.warn('[DB] Error:', (err as Error).message)
    return new NullDatabase()
  }
}
