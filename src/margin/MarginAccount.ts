import type { MarginPosition, MarginMode } from '../types/order.js'
import type { Address } from 'viem'

export interface MarginAccountState {
  maker:        Address
  totalBalance: bigint
  usedMargin:   bigint
  freeMargin:   bigint
  positions:    MarginPosition[]
}

export class MarginAccount {
  private readonly balances  = new Map<string, bigint>()
  private readonly positions = new Map<string, MarginPosition>()

  deposit(maker: Address, amount: bigint): void {
    const k = maker.toLowerCase()
    this.balances.set(k, (this.balances.get(k) ?? 0n) + amount)
  }

  withdraw(maker: Address, amount: bigint): boolean {
    const k = maker.toLowerCase()
    const bal = this.balances.get(k) ?? 0n
    if (bal < amount) return false
    this.balances.set(k, bal - amount)
    return true
  }

  updatePosition(pos: MarginPosition): void {
    this.positions.set(`${pos.maker.toLowerCase()}:${pos.pairId}`, { ...pos })
  }

  getState(maker: Address): MarginAccountState {
    const k = maker.toLowerCase()
    const totalBalance = this.balances.get(k) ?? 0n
    const positions    = [...this.positions.values()].filter(p => p.maker.toLowerCase() === k)
    const usedMargin   = positions
      .filter(p => p.mode === 'isolated')
      .reduce((sum, p) => sum + p.margin, 0n)
    return { maker, totalBalance, usedMargin, freeMargin: totalBalance - usedMargin, positions }
  }

  /**
   * Check if maker can open a position of the given size.
   * Cross mode:    effectiveMargin = totalBalance (free across all positions)
   * Isolated mode: effectiveMargin = freeMargin (totalBalance - sum of isolated position margins)
   * In both cases, effectiveMargin must cover requiredMargin.
   */
  canOpen(maker: Address, mode: MarginMode, requiredMargin: bigint): boolean {
    const state = this.getState(maker)
    const effective = mode === 'cross' ? state.totalBalance : state.freeMargin
    return effective >= requiredMargin
  }

  /**
   * Compute required margin from notional value and leverage.
   * requiredMargin = notional / leverage
   * Minimum 1n to prevent division-by-zero edge.
   */
  static requiredMargin(notional: bigint, leverage: bigint): bigint {
    if (leverage <= 0n) throw new Error('leverage must be positive')
    const margin = notional / leverage
    return margin === 0n ? 1n : margin
  }

  applyPnl(maker: Address, pnl: bigint): void {
    const k   = maker.toLowerCase()
    const bal = this.balances.get(k) ?? 0n
    const newBal = bal + pnl
    this.balances.set(k, newBal < 0n ? 0n : newBal)
  }
}
