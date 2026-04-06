import { describe, it, expect } from 'vitest'
import { MarginAccount } from './MarginAccount.js'
import type { Address } from 'viem'

const MAKER = '0xDeadBeef00000000000000000000000000000001' as `0x${string}`
const PAIR  = 'ETH/KRW'

describe('MarginAccount', () => {
  it('deposit() + getState() returns correct totalBalance', () => {
    const acct = new MarginAccount()
    acct.deposit(MAKER, 500n)
    acct.deposit(MAKER, 300n)
    const state = acct.getState(MAKER)
    expect(state.totalBalance).toBe(800n)
    expect(state.freeMargin).toBe(800n)
    expect(state.usedMargin).toBe(0n)
  })

  it('withdraw() succeeds when balance sufficient; returns false when insufficient', () => {
    const acct = new MarginAccount()
    acct.deposit(MAKER, 1000n)
    expect(acct.withdraw(MAKER, 400n)).toBe(true)
    expect(acct.getState(MAKER).totalBalance).toBe(600n)
    // Try to withdraw more than available
    expect(acct.withdraw(MAKER, 700n)).toBe(false)
    expect(acct.getState(MAKER).totalBalance).toBe(600n)
  })

  it('updatePosition() with isolated mode updates usedMargin; freeMargin = totalBalance - usedMargin', () => {
    const acct = new MarginAccount()
    acct.deposit(MAKER, 1000n)

    acct.updatePosition({
      maker:      MAKER,
      pairId:     PAIR,
      size:       1n * 10n ** 18n,
      margin:     200n,
      mode:       'isolated',
      entryPrice: 0n,
    })

    const state = acct.getState(MAKER)
    expect(state.usedMargin).toBe(200n)
    expect(state.freeMargin).toBe(800n)
    expect(state.positions).toHaveLength(1)
  })

  it('canOpen() returns true when freeMargin >= requiredMargin', () => {
    const acct = new MarginAccount()
    acct.deposit(MAKER, 1000n)

    expect(acct.canOpen(MAKER, 'isolated', 1000n)).toBe(true)
    expect(acct.canOpen(MAKER, 'isolated', 1001n)).toBe(false)

    // After using some margin
    acct.updatePosition({ maker: MAKER, pairId: PAIR, size: 1n, margin: 300n, mode: 'isolated', entryPrice: 0n })
    // freeMargin = 700
    expect(acct.canOpen(MAKER, 'isolated', 700n)).toBe(true)
    expect(acct.canOpen(MAKER, 'isolated', 701n)).toBe(false)
  })

  describe('canOpen — cross/isolated logic', () => {
    it('cross mode — uses totalBalance as effective margin', () => {
      const account = new MarginAccount()
      account.deposit('0xaaaa' as Address, 1000n)
      // cross mode uses totalBalance: 1000 >= 900 → true
      expect(account.canOpen('0xaaaa' as Address, 'cross', 900n)).toBe(true)
      expect(account.canOpen('0xaaaa' as Address, 'cross', 1001n)).toBe(false)
    })

    it('isolated mode — uses freeMargin (totalBalance - allocated isolated margin)', () => {
      const account = new MarginAccount()
      account.deposit('0xbbbb' as Address, 1000n)
      // Lock 400n in isolated position
      account.updatePosition({ maker: '0xbbbb' as Address, pairId: 'ETH/KRW', size: 1n, margin: 400n, mode: 'isolated', entryPrice: 0n })
      // freeMargin = 1000 - 400 = 600
      expect(account.canOpen('0xbbbb' as Address, 'isolated', 600n)).toBe(true)
      expect(account.canOpen('0xbbbb' as Address, 'isolated', 601n)).toBe(false)
    })
  })

  describe('requiredMargin', () => {
    it('divides notional by leverage', () => {
      expect(MarginAccount.requiredMargin(1000n, 10n)).toBe(100n)
      expect(MarginAccount.requiredMargin(500n, 5n)).toBe(100n)
    })

    it('returns 1n when notional < leverage (floor truncation)', () => {
      expect(MarginAccount.requiredMargin(5n, 10n)).toBe(1n)
    })

    it('throws on zero or negative leverage', () => {
      expect(() => MarginAccount.requiredMargin(1000n, 0n)).toThrow('leverage must be positive')
      expect(() => MarginAccount.requiredMargin(1000n, -1n)).toThrow('leverage must be positive')
    })
  })

  it('applyPnl() positive PnL increases balance; negative PnL decreases but floor at 0n', () => {
    const acct = new MarginAccount()
    acct.deposit(MAKER, 500n)

    acct.applyPnl(MAKER, 200n)
    expect(acct.getState(MAKER).totalBalance).toBe(700n)

    acct.applyPnl(MAKER, -300n)
    expect(acct.getState(MAKER).totalBalance).toBe(400n)

    // Apply large negative PnL — should floor at 0n
    acct.applyPnl(MAKER, -1000n)
    expect(acct.getState(MAKER).totalBalance).toBe(0n)
  })
})
