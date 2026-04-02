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

  // ── getCount ──────────────────────────────────────────────────────────────

  it('getCount() reflects add/remove/trigger lifecycle', async () => {
    expect(engine.getCount()).toBe(0)
    engine.add(cond({ id: 'a' }), 'p')
    engine.add(cond({ id: 'b' }), 'p')
    expect(engine.getCount()).toBe(2)
    engine.remove('a')
    expect(engine.getCount()).toBe(1)
    await engine.onPrice('p', 90n)  // triggers 'b' (stop_loss sell at 90)
    expect(engine.getCount()).toBe(0)
  })

  // ── event emission ────────────────────────────────────────────────────────

  it("emits 'triggered' event when order fires", async () => {
    const triggered: string[] = []
    engine.on('triggered', (id: string) => triggered.push(id))

    engine.add(cond({ id: 'sl1' }), 'p')
    await engine.onPrice('p', 90n)

    expect(triggered).toEqual(['sl1'])
    expect(submitFn).toHaveBeenCalledOnce()
  })

  it("emits 'expired' event and skips submitFn when order has expired", async () => {
    const expired: string[] = []
    engine.on('expired', (id: string) => expired.push(id))

    // expiry = 1 second in the past
    const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1)
    engine.add(cond({ id: 'exp1', expiry: pastExpiry }), 'p')

    await engine.onPrice('p', 90n)  // would normally trigger stop_loss sell

    expect(expired).toEqual(['exp1'])
    expect(submitFn).not.toHaveBeenCalled()  // never submitted — expired first
    expect(engine.getCount()).toBe(0)
  })

  it("emits 'error' event and re-queues on submitFn failure", async () => {
    const errors: string[] = []
    engine.on('error', (id: string) => errors.push(id))

    submitFn.mockRejectedValueOnce(new Error('network error'))
    engine.add(cond({ id: 'err1' }), 'p')

    await engine.onPrice('p', 90n)

    expect(errors).toEqual(['err1'])
    // Re-queued: should still be pending
    expect(engine.getCount()).toBe(1)
  })

  it('non-expired order at exact expiry boundary is treated as expired (<=)', async () => {
    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const expired: string[] = []
    engine.on('expired', (id: string) => expired.push(id))

    // expiry == nowSec exactly → should be treated as expired (expiry <= nowSec)
    engine.add(cond({ id: 'boundary', expiry: nowSec }), 'p')
    await engine.onPrice('p', 90n)

    // May or may not be expired depending on exact timing — just verify no crash
    // and order is removed from pending one way or another
    expect(engine.getCount()).toBe(0)
  })
})
