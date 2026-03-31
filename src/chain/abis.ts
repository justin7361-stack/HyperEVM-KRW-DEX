export const ORDER_SETTLEMENT_ABI = [
  {
    name: 'settleBatch',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'makerOrders',
        type: 'tuple[]',
        components: [
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
      },
      {
        name: 'takerOrder',
        type: 'tuple',
        components: [
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
      },
      { name: 'fillAmounts', type: 'uint256[]' },
      { name: 'makerSigs',   type: 'bytes[]'   },
      { name: 'takerSig',    type: 'bytes'     },
    ],
    outputs: [],
  },
  {
    name: 'domainSeparator',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'isNonceUsed',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user',  type: 'address' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'OrderFilled',
    type: 'event',
    inputs: [
      { name: 'orderHash',  type: 'bytes32', indexed: true  },
      { name: 'maker',      type: 'address', indexed: true  },
      { name: 'taker',      type: 'address', indexed: true  },
      { name: 'baseToken',  type: 'address', indexed: false },
      { name: 'fillAmount', type: 'uint256', indexed: false },
      { name: 'fee',        type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'OrderCancelled',
    type: 'event',
    inputs: [
      { name: 'user',  type: 'address', indexed: true  },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
  },
] as const

export const PAIR_REGISTRY_ABI = [
  {
    name: 'isTradeAllowed',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'baseToken',  type: 'address' },
      { name: 'quoteToken', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const

export const ORACLE_ADMIN_ABI = [
  {
    name: 'getPrice',
    type: 'function',
    stateMutability: 'view',
    inputs:  [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const
