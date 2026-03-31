import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SettlementWorker } from '../../src/core/settlement/SettlementWorker.js'
import type { MatchResult, StoredOrder } from '../../src/types/order.js'
import { v4 as uuid } from 'uuid'

function makeMatch(overrides: Partial<MatchResult> = {}): MatchResult {
  const base: StoredOrder = {
    id: uuid(), maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    baseToken: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: false,
    nonce: 0n, expiry: 9999999999n,
    signature: '0xabc', submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '1.2.3.4',
  }
  const taker: StoredOrder = { ...base, id: uuid(), isBuy: true,
    maker: '0x2222222222222222222222222222222222222222',
    taker: '0x1111111111111111111111111111111111111111',
    signature: '0xdef',
  }
  return {
    makerOrder: base, takerOrder: taker,
    fillAmount: 1n * 10n**18n, price: 1350n * 10n**18n, matchedAt: Date.now(),
    ...overrides,
  }
}

describe('SettlementWorker', () => {
  let settleFn: ReturnType<typeof vi.fn>
  let worker: SettlementWorker

  beforeEach(() => {
    vi.useFakeTimers()
    settleFn = vi.fn().mockResolvedValue('0xtxhash')
    worker = new SettlementWorker({ batchSize: 3, batchTimeoutMs: 1000, settle: settleFn })
  })

  afterEach(() => {
    worker.stop()
    vi.useRealTimers()
  })

  it('flushes when batch size is reached', async () => {
    worker.enqueue(makeMatch())
    worker.enqueue(makeMatch())
    worker.enqueue(makeMatch())   // triggers flush at 3
    await vi.runAllTimersAsync()
    expect(settleFn).toHaveBeenCalledTimes(1)
    expect(settleFn.mock.calls[0][0]).toHaveLength(3)
  })

  it('flushes after timeout even with fewer items', async () => {
    worker.enqueue(makeMatch())
    await vi.advanceTimersByTimeAsync(1001)
    expect(settleFn).toHaveBeenCalledTimes(1)
  })

  it('does not flush empty queue', async () => {
    await vi.advanceTimersByTimeAsync(1001)
    expect(settleFn).not.toHaveBeenCalled()
  })
})
