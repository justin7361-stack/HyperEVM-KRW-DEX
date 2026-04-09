import { describe, it, expect, vi } from 'vitest'
import { AgentAwareVerifier } from './AgentAwareVerifier.js'
import { AgentWalletStore } from './AgentWalletStore.js'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { Order } from '../types/order.js'

const DOMAIN = {
  name:              'KRW DEX',
  version:           '1',
  chainId:           31337n,
  verifyingContract: '0x0000000000000000000000000000000000000001' as `0x${string}`,
}

const MAKER = '0x1111000000000000000000000000000000000001'
const AGENT = '0x2222000000000000000000000000000000000002'

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id:         '1',
    maker:      MAKER,
    taker:      '0x0000000000000000000000000000000000000000',
    baseToken:  '0xAAAA000000000000000000000000000000000001',
    quoteToken: '0xBBBB000000000000000000000000000000000002',
    price:      1000n,
    amount:     10n,
    isBuy:      true,
    nonce:      0n,
    expiry:     9999999999n,
    status:     'open',
    ...overrides,
  } as Order
}

function makeInner(result: boolean): IOrderVerifier {
  return { verify: vi.fn().mockResolvedValue(result) }
}

describe('AgentAwareVerifier', () => {
  it('accepts signature when inner verifier succeeds (direct maker sig)', async () => {
    const agentStore = new AgentWalletStore()
    const verifier   = new AgentAwareVerifier(makeInner(true), agentStore, DOMAIN)
    expect(await verifier.verify(makeOrder(), '0xdeadbeef' as `0x${string}`)).toBe(true)
  })

  it('rejects when inner fails and no agent registered', async () => {
    const agentStore = new AgentWalletStore()
    const verifier   = new AgentAwareVerifier(makeInner(false), agentStore, DOMAIN)
    expect(await verifier.verify(makeOrder(), '0xdeadbeef' as `0x${string}`)).toBe(false)
  })

  it('rejects when inner fails and sig does not recover to agent', async () => {
    const agentStore = new AgentWalletStore()
    agentStore.set(MAKER, AGENT)
    const verifier = new AgentAwareVerifier(makeInner(false), agentStore, DOMAIN)
    // '0xdeadbeef' is not a valid ECDSA sig — recoverTypedDataAddress will throw, caught → false
    expect(await verifier.verify(makeOrder(), '0xdeadbeef' as `0x${string}`)).toBe(false)
  })

  it('calls inner verifier exactly once when it succeeds', async () => {
    const agentStore = new AgentWalletStore()
    const inner      = makeInner(true)
    const verifier   = new AgentAwareVerifier(inner, agentStore, DOMAIN)
    await verifier.verify(makeOrder(), '0xdeadbeef' as `0x${string}`)
    expect(inner.verify).toHaveBeenCalledOnce()
  })

  it('calls inner verifier exactly once even when it fails (then tries agent path)', async () => {
    const agentStore = new AgentWalletStore()
    const inner      = makeInner(false)
    const verifier   = new AgentAwareVerifier(inner, agentStore, DOMAIN)
    await verifier.verify(makeOrder(), '0xdeadbeef' as `0x${string}`)
    expect(inner.verify).toHaveBeenCalledOnce()
  })
})
