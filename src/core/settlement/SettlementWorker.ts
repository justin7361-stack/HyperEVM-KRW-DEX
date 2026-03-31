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
  }

  enqueue(match: MatchResult): void {
    const wasEmpty = this.queue.length === 0
    this.queue.push(match)
    // Only start timer on first item OR if timer was stopped previously
    if (wasEmpty || !this.timer) {
      this.start()
    }
    if (this.queue.length >= this.opts.batchSize) {
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
    // Always stop timer during settlement to prevent conflicts
    this.stop()
    this.opts.settle(batch)
      .then(txHash => this.emit('settled', batch, txHash))
      .catch(err => this.emit('error', batch, err))
  }

  private start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.flush(), this.opts.batchTimeoutMs)
    }
  }
}
