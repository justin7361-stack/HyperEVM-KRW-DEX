import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConditionalOrderEngine } from './ConditionalOrderEngine.js'
import type { StoredOrder } from '../../types/order.js'

function cond(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id: 'c1', maker: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any,
    taker: '0x0000000000000000000000000000000000000000' as any,
    baseToken: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as any,
    quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as any,
    price: 0n, amount: 10n, isBuy: false, nonce: 1n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature: '0x' as any, submittedAt: Date.now(),
    filledAmount: 0n, status: 'open', makerIp: '127.0.0.1',
    orderType: 'market', conditionType: 'stop_loss', triggerPrice: 90n, ...overrides,
  }
}

describe('ConditionalOrderEngine', () => {
  let submitFn: ReturnType<typeof vi.fn>
  let engine: ConditionalOrderEngine
  beforeEach(() => {
    submitFn = vi.fn().mockResolvedValue(undefined)
    engine = new ConditionalOrderEngine(submitFn)
  })

  it('stop_loss sell: triggers at/below triggerPrice', async () => {
    engine.add(cond({ isBuy: false, conditionType: 'stop_loss', triggerPrice: 90n }), 'p')
    await engine.onPrice('p', 91n)
    expect(submitFn).not.toHaveBeenCalled()
    await engine.onPrice('p', 90n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('take_profit sell: triggers at/above triggerPrice', async () => {
    engine.add(cond({ isBuy: false, conditionType: 'take_profit', triggerPrice: 110n }), 'p')
    await engine.onPrice('p', 109n)
    expect(submitFn).not.toHaveBeenCalled()
    await engine.onPrice('p', 110n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('stop_loss buy: triggers at/above triggerPrice', async () => {
    engine.add(cond({ isBuy: true, conditionType: 'stop_loss', triggerPrice: 110n }), 'p')
    await engine.onPrice('p', 110n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('take_profit buy: triggers at/below triggerPrice', async () => {
    engine.add(cond({ isBuy: true, conditionType: 'take_profit', triggerPrice: 90n }), 'p')
    await engine.onPrice('p', 90n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('triggers only once — removed after firing', async () => {
    engine.add(cond(), 'p')
    await engine.onPrice('p', 90n)
    await engine.onPrice('p', 80n)
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it('remove() prevents triggering', async () => {
    engine.add(cond(), 'p')
    engine.remove('c1')
    await engine.onPrice('p', 90n)
    expect(submitFn).not.toHaveBeenCalled()
  })

  it('different pairId does not trigger', async () => {
    engine.add(cond(), 'pairA')
    await engine.onPrice('pairB', 85n)
    expect(submitFn).not.toHaveBeenCalled()
  })
})
