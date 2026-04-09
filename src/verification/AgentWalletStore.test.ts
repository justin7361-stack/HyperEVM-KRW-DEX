import { describe, it, expect } from 'vitest'
import { AgentWalletStore } from './AgentWalletStore.js'

describe('AgentWalletStore', () => {
  it('stores and retrieves agent (case-insensitive)', () => {
    const store = new AgentWalletStore()
    store.set('0xAAAA000000000000000000000000000000000001', '0xBBBB000000000000000000000000000000000002')
    expect(store.get('0xAAAA000000000000000000000000000000000001')).toBe(
      '0xbbbb000000000000000000000000000000000002',
    )
  })

  it('get is case-insensitive on lookup', () => {
    const store = new AgentWalletStore()
    store.set('0xAAAA000000000000000000000000000000000001', '0xBBBB000000000000000000000000000000000002')
    expect(store.get('0xaaaa000000000000000000000000000000000001')).toBeDefined()
  })

  it('returns undefined for unknown trader', () => {
    const store = new AgentWalletStore()
    expect(store.get('0x1234000000000000000000000000000000000001')).toBeUndefined()
  })

  it('overwrites existing agent', () => {
    const store = new AgentWalletStore()
    store.set('0xAAAA000000000000000000000000000000000001', '0xBBBB000000000000000000000000000000000002')
    store.set('0xAAAA000000000000000000000000000000000001', '0xCCCC000000000000000000000000000000000003')
    expect(store.get('0xAAAA000000000000000000000000000000000001')).toBe(
      '0xcccc000000000000000000000000000000000003',
    )
  })

  it('delete returns true when entry existed', () => {
    const store = new AgentWalletStore()
    store.set('0xAAAA000000000000000000000000000000000001', '0xBBBB000000000000000000000000000000000002')
    expect(store.delete('0xAAAA000000000000000000000000000000000001')).toBe(true)
    expect(store.get('0xAAAA000000000000000000000000000000000001')).toBeUndefined()
  })

  it('delete returns false when no entry', () => {
    const store = new AgentWalletStore()
    expect(store.delete('0x1234000000000000000000000000000000000001')).toBe(false)
  })

  it('getAll returns all delegations', () => {
    const store = new AgentWalletStore()
    store.set('0xAAAA000000000000000000000000000000000001', '0xBBBB000000000000000000000000000000000002')
    store.set('0xCCCC000000000000000000000000000000000003', '0xDDDD000000000000000000000000000000000004')
    expect(store.getAll()).toHaveLength(2)
  })
})
