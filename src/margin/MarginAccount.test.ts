import { describe, it, expect } from 'vitest'
import { MarginAccount } from './MarginAccount.js'

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
      maker:  MAKER,
      pairId: PAIR,
      size:   1n * 10n ** 18n,
      margin: 200n,
      mode:   'isolated',
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
    acct.updatePosition({ maker: MAKER, pairId: PAIR, size: 1n, margin: 300n, mode: 'isolated' })
    // freeMargin = 700
    expect(acct.canOpen(MAKER, 'isolated', 700n)).toBe(true)
    expect(acct.canOpen(MAKER, 'isolated', 701n)).toBe(false)
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
