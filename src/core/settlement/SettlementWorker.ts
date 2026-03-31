import { EventEmitter } from 'events'
import type { MatchResult } from '../../types/order.js'

export interface SettlementWorkerOptions {
  batchSize:      number
  batchTimeoutMs: number
  settle:         (batch: MatchResult[]) => Promise<string>  // returns txHash
}

// Events:
//   'settled'  (batch: MatchResult[], txHash: string)
//   'error'    (batch: MatchResult[], err: Error)
export class SettlementWorker extends EventEmitter {
  private queue: MatchResult[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly opts: SettlementWorkerOptions) {
    super()
    this.timer = setInterval(() => this.flush(), this.opts.batchTimeoutMs)
  }

  enqueue(match: MatchResult): void {
    this.queue.push(match)
    if (this.queue.length >= this.opts.batchSize) {
      this.stop()
      this.flush()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    this.opts.settle(batch)
      .then(txHash => this.emit('settled', batch, txHash))
      .catch(err   => this.emit('error',   batch, err))
  }
}
