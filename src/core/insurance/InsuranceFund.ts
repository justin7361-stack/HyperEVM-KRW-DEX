import { EventEmitter } from 'events'

/** Narrow interface used for dependency injection — avoids coupling to EventEmitter internals */
export interface IInsuranceFund {
  cover(pairId: string, loss: bigint): boolean
  deposit(pairId: string, amount: bigint): void
  getBalance(pairId: string): bigint
}

export interface InsuranceFundSnapshot {
  pairId:  string
  balance: bigint
}

// Events: 'adl_needed' (pairId: string, shortfall: bigint)
export class InsuranceFund extends EventEmitter {
  private readonly balances = new Map<string, bigint>()

  /** Deposit profits/fees into the fund for a pair */
  deposit(pairId: string, amount: bigint): void {
    if (amount <= 0n) return
    const current = this.balances.get(pairId) ?? 0n
    this.balances.set(pairId, current + amount)
  }

  /**
   * Attempt to cover a loss from the fund.
   * Returns true if fully covered, false if fund was insufficient.
   * Emits 'adl_needed' with the unmet shortfall if insufficient.
   */
  cover(pairId: string, loss: bigint): boolean {
    if (loss <= 0n) return true
    const balance = this.balances.get(pairId) ?? 0n
    if (balance >= loss) {
      this.balances.set(pairId, balance - loss)
      return true
    }
    // Drain remaining balance, emit shortfall
    this.balances.set(pairId, 0n)
    const shortfall = loss - balance
    this.emit('adl_needed', pairId, shortfall)
    return false
  }

  /** Get current balance for a pair (0n if unknown) */
  getBalance(pairId: string): bigint {
    return this.balances.get(pairId) ?? 0n
  }

  /** Get snapshot of all balances */
  getSnapshot(): InsuranceFundSnapshot[] {
    return [...this.balances.entries()].map(([pairId, balance]) => ({ pairId, balance }))
  }
}
