import { describe, it, expect } from 'vitest'
import { InsuranceFund } from './InsuranceFund.js'

const PAIR = 'ETH/KRW'
const PAIR2 = 'BTC/KRW'

describe('InsuranceFund', () => {
  it('deposit() accumulates balance across multiple deposits', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 100n)
    fund.deposit(PAIR, 50n)
    expect(fund.getBalance(PAIR)).toBe(150n)
  })

  it('deposit() ignores zero and negative amounts', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 100n)
    fund.deposit(PAIR, 0n)
    fund.deposit(PAIR, -5n)
    expect(fund.getBalance(PAIR)).toBe(100n)
  })

  it('cover() fully covers loss when balance is sufficient — returns true, reduces balance', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 100n)
    const result = fund.cover(PAIR, 60n)
    expect(result).toBe(true)
    expect(fund.getBalance(PAIR)).toBe(40n)
  })

  it('cover() partially covers and emits adl_needed when balance is insufficient', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 30n)

    const adlEvents: Array<{ pairId: string; shortfall: bigint }> = []
    fund.on('adl_needed', (pairId: string, shortfall: bigint) => {
      adlEvents.push({ pairId, shortfall })
    })

    const result = fund.cover(PAIR, 100n)
    expect(result).toBe(false)
    expect(fund.getBalance(PAIR)).toBe(0n)
    expect(adlEvents).toHaveLength(1)
    expect(adlEvents[0].pairId).toBe(PAIR)
    expect(adlEvents[0].shortfall).toBe(70n)
  })

  it('cover() with empty fund emits adl_needed with full loss amount', () => {
    const fund = new InsuranceFund()

    const adlEvents: Array<{ pairId: string; shortfall: bigint }> = []
    fund.on('adl_needed', (pairId: string, shortfall: bigint) => {
      adlEvents.push({ pairId, shortfall })
    })

    const result = fund.cover(PAIR, 50n)
    expect(result).toBe(false)
    expect(adlEvents).toHaveLength(1)
    expect(adlEvents[0].pairId).toBe(PAIR)
    expect(adlEvents[0].shortfall).toBe(50n)
  })

  it('cover() with loss=0n returns true without touching balance', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 100n)

    const adlEvents: unknown[] = []
    fund.on('adl_needed', (...args: unknown[]) => adlEvents.push(args))

    const result = fund.cover(PAIR, 0n)
    expect(result).toBe(true)
    expect(fund.getBalance(PAIR)).toBe(100n)
    expect(adlEvents).toHaveLength(0)
  })

  it('getBalance() returns 0n for an unknown pair', () => {
    const fund = new InsuranceFund()
    expect(fund.getBalance('UNKNOWN/PAIR')).toBe(0n)
  })

  it('getSnapshot() returns all pair balances', () => {
    const fund = new InsuranceFund()
    fund.deposit(PAIR, 200n)
    fund.deposit(PAIR2, 500n)

    const snapshot = fund.getSnapshot()
    expect(snapshot).toHaveLength(2)

    const byPair = Object.fromEntries(snapshot.map(s => [s.pairId, s.balance]))
    expect(byPair[PAIR]).toBe(200n)
    expect(byPair[PAIR2]).toBe(500n)
  })
})
