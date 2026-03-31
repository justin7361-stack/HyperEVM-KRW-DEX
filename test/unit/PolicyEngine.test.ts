import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { PolicyEngine } from '../../src/compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from '../../src/compliance/plugins/BasicBlocklistPlugin.js'
import type { TradeContext } from '../../src/compliance/IPolicyPlugin.js'

const ctx: TradeContext = {
  maker:      '0x1111111111111111111111111111111111111111',
  taker:      '0x2222222222222222222222222222222222222222',
  baseToken:  '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  quoteToken: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  amount:     1n * 10n ** 18n,
  price:      1350n * 10n ** 18n,
  makerIp:    '1.2.3.4',
}

describe('PolicyEngine', () => {
  it('allows trade when no plugins registered', async () => {
    const engine = new PolicyEngine()
    const result = await engine.check(ctx)
    expect(result.allowed).toBe(true)
  })

  it('blocks trade when maker is on blocklist', async () => {
    const engine = new PolicyEngine()
    const blocked = new Set<Address>([ctx.maker])
    engine.register(new BasicBlocklistPlugin(blocked))

    const result = await engine.check(ctx)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('blocklist')
  })

  it('blocks trade when taker is on blocklist', async () => {
    const engine = new PolicyEngine()
    const blocked = new Set<Address>([ctx.taker])
    engine.register(new BasicBlocklistPlugin(blocked))

    const result = await engine.check(ctx)
    expect(result.allowed).toBe(false)
  })

  it('stops at first rejection and does not run subsequent plugins', async () => {
    const engine = new PolicyEngine()
    let secondPluginCalled = false

    engine.register(new BasicBlocklistPlugin(new Set([ctx.maker])))
    engine.register({
      name: 'spy',
      check: async () => { secondPluginCalled = true; return { allowed: true } },
    })

    await engine.check(ctx)
    expect(secondPluginCalled).toBe(false)
  })

  it('allows trade when blocklist is empty', async () => {
    const engine = new PolicyEngine()
    engine.register(new BasicBlocklistPlugin(new Set()))
    const result = await engine.check(ctx)
    expect(result.allowed).toBe(true)
  })
})
