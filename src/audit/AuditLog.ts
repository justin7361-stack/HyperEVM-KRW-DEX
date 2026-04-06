/**
 * AuditLog — O-7: Compliance audit trail.
 *
 * Records every order action (submit, cancel, match, reject) with timestamp,
 * maker address, IP, and relevant context. Outputs structured JSON logs to
 * stdout (readable by log aggregators like Loki, CloudWatch, Datadog).
 *
 * Production upgrade path: swap `_emit()` to write to PostgreSQL audit_log
 * table once O-1 (persistence layer) is wired. The interface remains stable.
 *
 * Reference pattern: dYdX v4 compliance audit logging (compliance service).
 */

export type AuditAction =
  | 'order.submitted'
  | 'order.cancelled'
  | 'order.rejected'
  | 'order.matched'
  | 'order.expired'
  | 'margin.deposit'
  | 'margin.withdraw'
  | 'compliance.blocked'

export interface AuditEntry {
  ts:       number       // Unix ms timestamp
  action:   AuditAction
  maker:    string       // Ethereum address (lowercase)
  orderId?: string
  pairId?:  string
  amount?:  string       // bigint as decimal string
  price?:   string
  ip?:      string
  reason?:  string       // for rejected/blocked
  txHash?:  string       // for on-chain settlement
}

export class AuditLog {
  private readonly serviceName: string

  constructor(serviceName = 'krw-dex') {
    this.serviceName = serviceName
  }

  log(entry: AuditEntry): void {
    this._emit(entry)
  }

  orderSubmitted(maker: string, orderId: string, pairId: string, amount: bigint, price: bigint, ip: string): void {
    this.log({ ts: Date.now(), action: 'order.submitted', maker: maker.toLowerCase(), orderId, pairId, amount: amount.toString(), price: price.toString(), ip })
  }

  orderCancelled(maker: string, orderId: string, pairId: string, ip?: string): void {
    this.log({ ts: Date.now(), action: 'order.cancelled', maker: maker.toLowerCase(), orderId, pairId, ip })
  }

  orderRejected(maker: string, orderId: string, pairId: string, reason: string, ip?: string): void {
    this.log({ ts: Date.now(), action: 'order.rejected', maker: maker.toLowerCase(), orderId, pairId, reason, ip })
  }

  orderMatched(maker: string, taker: string, orderId: string, pairId: string, amount: bigint, price: bigint, txHash?: string): void {
    this.log({ ts: Date.now(), action: 'order.matched', maker: maker.toLowerCase(), orderId, pairId, amount: amount.toString(), price: price.toString(), txHash })
  }

  complianceBlocked(maker: string, ip: string, reason: string): void {
    this.log({ ts: Date.now(), action: 'compliance.blocked', maker: maker.toLowerCase(), ip, reason })
  }

  private _emit(entry: AuditEntry): void {
    // Structured JSON — production: pipe to PostgreSQL or log aggregator
    console.log(JSON.stringify({
      service: this.serviceName,
      level:   'audit',
      ...entry,
    }))
  }
}

/** Singleton shared across the process */
export const auditLog = new AuditLog()
