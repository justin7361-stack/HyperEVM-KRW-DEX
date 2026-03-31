import { describe, it, expect } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { EIP712Verifier } from '../../src/verification/EIP712Verifier.js'
import type { Order } from '../../src/types/order.js'

const DOMAIN = {
  name: 'KRW DEX' as const,
  version: '1' as const,
  chainId: 1337n,
  verifyingContract: '0x0000000000000000000000000000000000000001' as Address,
}

const TYPES = {
  Order: [
    { name: 'maker',      type: 'address' },
    { name: 'taker',      type: 'address' },
    { name: 'baseToken',  type: 'address' },
    { name: 'quoteToken', type: 'address' },
    { name: 'price',      type: 'uint256' },
    { name: 'amount',     type: 'uint256' },
    { name: 'isBuy',      type: 'bool'    },
    { name: 'nonce',      type: 'uint256' },
    { name: 'expiry',     type: 'uint256' },
  ],
} as const

function makeOrder(maker: Address): Order {
  return {
    maker,
    taker:      '0x0000000000000000000000000000000000000000',
    baseToken:  '0x0000000000000000000000000000000000000002',
    quoteToken: '0x0000000000000000000000000000000000000003',
    price:      1350n * 10n ** 18n,
    amount:     1n * 10n ** 18n,
    isBuy:      true,
    nonce:      0n,
    expiry:     BigInt(Math.floor(Date.now() / 1000) + 3600),
  }
}

describe('EIP712Verifier', () => {
  it('returns true for a valid signature', async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const order = makeOrder(account.address)

    const sig = await account.signTypedData({
      domain: DOMAIN, types: TYPES, primaryType: 'Order', message: order,
    })

    const verifier = new EIP712Verifier(DOMAIN)
    expect(await verifier.verify(order, sig)).toBe(true)
  })

  it('returns false when signed by wrong account', async () => {
    const pk1 = generatePrivateKey()
    const pk2 = generatePrivateKey()
    const maker = privateKeyToAccount(pk1)
    const other = privateKeyToAccount(pk2)
    const order = makeOrder(maker.address)

    const sig = await other.signTypedData({
      domain: DOMAIN, types: TYPES, primaryType: 'Order', message: order,
    })

    const verifier = new EIP712Verifier(DOMAIN)
    expect(await verifier.verify(order, sig)).toBe(false)
  })

  it('returns false for malformed signature', async () => {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    const order = makeOrder(account.address)
    const verifier = new EIP712Verifier(DOMAIN)
    expect(await verifier.verify(order, '0xdeadbeef')).toBe(false)
  })
})
