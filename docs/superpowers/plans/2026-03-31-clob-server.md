# HyperKRW CLOB Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HyperKRW DEX의 오프체인 CLOB 매칭 서버를 TypeScript로 구현한다 — EIP-712 주문 수신, 인메모리 오더북 매칭, HyperEVM settleBatch 정산, WebSocket 실시간 스트림.

**Architecture:** Fastify API Gateway → MatchingEngine (EventEmitter 기반, 확장 시 worker_threads 전환) → SettlementWorker (1s/10건 배치) → HyperEVM. IPolicyPlugin으로 컴플라이언스 플러그인 교체, IOrderVerifier로 ZKP 전환 준비, IOrderBookStore로 Redis 확장 경로 확보.

**Tech Stack:** Node.js 20 LTS + TypeScript 5, Fastify 4, @fastify/websocket, viem 2, Vitest, geoip-lite, uuid

---

## 파일 구조

```
krw-dex-server/
├── src/
│   ├── types/order.ts
│   ├── config/config.ts
│   ├── chain/
│   │   ├── abis.ts
│   │   ├── contracts.ts
│   │   └── wallet.ts
│   ├── verification/
│   │   ├── IOrderVerifier.ts
│   │   ├── EIP712Verifier.ts
│   │   └── ZKVerifier.ts
│   ├── compliance/
│   │   ├── IPolicyPlugin.ts
│   │   ├── PolicyEngine.ts
│   │   └── plugins/
│   │       ├── BasicBlocklistPlugin.ts
│   │       └── GeoBlockPlugin.ts
│   ├── core/
│   │   ├── orderbook/
│   │   │   ├── IOrderBookStore.ts
│   │   │   ├── MemoryOrderBookStore.ts
│   │   │   └── OrderBook.ts
│   │   ├── matching/
│   │   │   └── MatchingEngine.ts
│   │   ├── settlement/
│   │   │   └── SettlementWorker.ts
│   │   └── watcher/
│   │       └── ChainWatcher.ts
│   ├── api/
│   │   ├── routes/
│   │   │   ├── orders.ts
│   │   │   ├── orderbook.ts
│   │   │   └── trades.ts
│   │   ├── websocket/
│   │   │   └── stream.ts
│   │   └── server.ts
│   └── index.ts
├── test/
│   ├── unit/
│   │   ├── EIP712Verifier.test.ts
│   │   ├── PolicyEngine.test.ts
│   │   ├── MemoryOrderBookStore.test.ts
│   │   ├── OrderBook.test.ts
│   │   └── SettlementWorker.test.ts
│   └── integration/
│       └── api.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

---

## Task 1: 프로젝트 셋업

**Files:**
- Create: `krw-dex-server/package.json`
- Create: `krw-dex-server/tsconfig.json`
- Create: `krw-dex-server/vitest.config.ts`
- Create: `krw-dex-server/.env.example`
- Create: `krw-dex-server/.gitignore`

- [ ] **Step 1: 디렉토리 생성 및 package.json 작성**

```bash
mkdir -p ~/krw-dex-server && cd ~/krw-dex-server
```

`package.json`:
```json
{
  "name": "krw-dex-server",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/cors": "^9.0.1",
    "@fastify/rate-limit": "^9.1.0",
    "@fastify/websocket": "^10.0.1",
    "fastify": "^4.28.0",
    "geoip-lite": "^1.4.10",
    "uuid": "^10.0.0",
    "viem": "^2.21.0"
  },
  "devDependencies": {
    "@types/geoip-lite": "^1.4.4",
    "@types/node": "^20.14.0",
    "@types/uuid": "^10.0.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: tsconfig.json 작성**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: vitest.config.ts 작성**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
})
```

- [ ] **Step 4: .env.example 작성**

```bash
# HyperEVM RPC
RPC_URL=https://rpc.hyperliquid-testnet.xyz/evm
CHAIN_ID=998

# Operator wallet (OPERATOR_ROLE on OrderSettlement)
OPERATOR_PRIVATE_KEY=0x...

# Deployed contract addresses
ORDER_SETTLEMENT_ADDRESS=0x...
PAIR_REGISTRY_ADDRESS=0x...
ORACLE_ADMIN_ADDRESS=0x...

# Server
PORT=3000
HOST=0.0.0.0

# Batch settlement config
BATCH_TIMEOUT_MS=1000
BATCH_SIZE=10

# Geo-blocking (comma-separated ISO country codes to block)
BLOCKED_COUNTRIES=KP,IR,SY,CU
```

- [ ] **Step 5: .gitignore 작성**

```
node_modules/
dist/
.env
*.env.local
```

- [ ] **Step 6: 의존성 설치 및 확인**

```bash
npm install
```

Expected: `node_modules/` 생성, 오류 없음

- [ ] **Step 7: Git 초기화 및 커밋**

```bash
git init
git add package.json tsconfig.json vitest.config.ts .env.example .gitignore
git commit -m "chore: project setup"
```

---

## Task 2: 타입 정의 + Config

**Files:**
- Create: `src/types/order.ts`
- Create: `src/config/config.ts`

- [ ] **Step 1: 타입 작성**

`src/types/order.ts`:
```typescript
import type { Address, Hex } from 'viem'

export interface Order {
  maker: Address
  taker: Address          // '0x0000...0000' = any taker
  baseToken: Address
  quoteToken: Address
  price: bigint           // quoteToken per baseToken (18 decimals)
  amount: bigint          // baseToken quantity (18 decimals)
  isBuy: boolean
  nonce: bigint
  expiry: bigint          // unix timestamp seconds
  proof?: Hex             // reserved for future ZKP
}

export interface StoredOrder extends Order {
  id: string              // uuid
  signature: Hex
  submittedAt: number     // Date.now()
  filledAmount: bigint
  status: 'open' | 'partial' | 'filled' | 'cancelled' | 'expired'
  makerIp: string         // for GeoBlock plugin
}

export interface MatchResult {
  makerOrder: StoredOrder
  takerOrder: StoredOrder
  fillAmount: bigint
  price: bigint           // execution price (makerOrder.price)
  matchedAt: number       // Date.now()
}

export interface PriceLevel {
  price: bigint
  amount: bigint          // total available at this level
  orderCount: number
}

export interface OrderBookDepth {
  pairId: string
  bids: PriceLevel[]      // sorted price DESC
  asks: PriceLevel[]      // sorted price ASC
  timestamp: number
}

export interface TradeRecord {
  id: string
  pairId: string
  price: bigint
  amount: bigint
  isBuyerMaker: boolean
  tradedAt: number
  txHash?: Hex            // populated after on-chain settlement
}
```

- [ ] **Step 2: Config 작성**

`src/config/config.ts`:
```typescript
import type { Address, Hex } from 'viem'

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) throw new Error(`Missing required env var: ${key}`)
  return val
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback
}

export interface Config {
  rpcUrl: string
  chainId: number
  operatorPrivateKey: Hex
  orderSettlementAddress: Address
  pairRegistryAddress: Address
  oracleAdminAddress: Address
  port: number
  host: string
  batchTimeoutMs: number
  batchSize: number
  blockedCountries: string[]
}

export function loadConfig(): Config {
  return {
    rpcUrl:                  requireEnv('RPC_URL'),
    chainId:                 parseInt(requireEnv('CHAIN_ID'), 10),
    operatorPrivateKey:      requireEnv('OPERATOR_PRIVATE_KEY') as Hex,
    orderSettlementAddress:  requireEnv('ORDER_SETTLEMENT_ADDRESS') as Address,
    pairRegistryAddress:     requireEnv('PAIR_REGISTRY_ADDRESS') as Address,
    oracleAdminAddress:      requireEnv('ORACLE_ADMIN_ADDRESS') as Address,
    port:                    parseInt(optionalEnv('PORT', '3000'), 10),
    host:                    optionalEnv('HOST', '0.0.0.0'),
    batchTimeoutMs:          parseInt(optionalEnv('BATCH_TIMEOUT_MS', '1000'), 10),
    batchSize:               parseInt(optionalEnv('BATCH_SIZE', '10'), 10),
    blockedCountries:        optionalEnv('BLOCKED_COUNTRIES', 'KP,IR,SY,CU').split(','),
  }
}
```

- [ ] **Step 3: 커밋**

```bash
git add src/types/order.ts src/config/config.ts
git commit -m "feat: core types and config"
```

---

## Task 3: Chain Layer

**Files:**
- Create: `src/chain/abis.ts`
- Create: `src/chain/contracts.ts`
- Create: `src/chain/wallet.ts`

- [ ] **Step 1: ABIs 작성**

`src/chain/abis.ts`:
```typescript
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
```

- [ ] **Step 2: contracts.ts 작성**

`src/chain/contracts.ts`:
```typescript
import { createPublicClient, http, getContract } from 'viem'
import type { Config } from '../config/config.js'
import { ORDER_SETTLEMENT_ABI, PAIR_REGISTRY_ABI, ORACLE_ADMIN_ABI } from './abis.js'

export function createClients(config: Config) {
  const publicClient = createPublicClient({
    transport: http(config.rpcUrl),
  })

  const orderSettlement = getContract({
    address: config.orderSettlementAddress,
    abi: ORDER_SETTLEMENT_ABI,
    client: publicClient,
  })

  const pairRegistry = getContract({
    address: config.pairRegistryAddress,
    abi: PAIR_REGISTRY_ABI,
    client: publicClient,
  })

  const oracleAdmin = getContract({
    address: config.oracleAdminAddress,
    abi: ORACLE_ADMIN_ABI,
    client: publicClient,
  })

  return { publicClient, orderSettlement, pairRegistry, oracleAdmin }
}

export type Clients = ReturnType<typeof createClients>
```

- [ ] **Step 3: wallet.ts 작성**

`src/chain/wallet.ts`:
```typescript
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Config } from '../config/config.js'

export function createOperatorWallet(config: Config) {
  const account = privateKeyToAccount(config.operatorPrivateKey)
  const walletClient = createWalletClient({
    account,
    transport: http(config.rpcUrl),
  })
  return { walletClient, account }
}

export type OperatorWallet = ReturnType<typeof createOperatorWallet>
```

- [ ] **Step 4: 커밋**

```bash
git add src/chain/
git commit -m "feat: chain layer (ABIs, contracts, wallet)"
```

---

## Task 4: Verification Layer

**Files:**
- Create: `src/verification/IOrderVerifier.ts`
- Create: `src/verification/EIP712Verifier.ts`
- Create: `src/verification/ZKVerifier.ts`
- Create: `test/unit/EIP712Verifier.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/EIP712Verifier.test.ts`:
```typescript
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
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
npx vitest run test/unit/EIP712Verifier.test.ts
```

Expected: FAIL — `Cannot find module`

- [ ] **Step 3: IOrderVerifier 인터페이스 작성**

`src/verification/IOrderVerifier.ts`:
```typescript
import type { Hex } from 'viem'
import type { Order } from '../types/order.js'

export interface IOrderVerifier {
  verify(order: Order, sig: Hex): Promise<boolean>
}
```

- [ ] **Step 4: EIP712Verifier 구현**

`src/verification/EIP712Verifier.ts`:
```typescript
import { verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { Order } from '../types/order.js'

const ORDER_TYPES = {
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

interface Eip712Domain {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
}

export class EIP712Verifier implements IOrderVerifier {
  constructor(private readonly domain: Eip712Domain) {}

  async verify(order: Order, sig: Hex): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: order.maker,
        domain: this.domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message: {
          maker:      order.maker,
          taker:      order.taker,
          baseToken:  order.baseToken,
          quoteToken: order.quoteToken,
          price:      order.price,
          amount:     order.amount,
          isBuy:      order.isBuy,
          nonce:      order.nonce,
          expiry:     order.expiry,
        },
        signature: sig,
      })
    } catch {
      return false
    }
  }
}
```

- [ ] **Step 5: ZKVerifier stub 작성**

`src/verification/ZKVerifier.ts`:
```typescript
import type { Hex } from 'viem'
import type { IOrderVerifier } from './IOrderVerifier.js'
import type { Order } from '../types/order.js'

// Future: snarkjs + circom based proof verification
// Swap this for EIP712Verifier in config when ZKP is ready.
export class ZKVerifier implements IOrderVerifier {
  async verify(_order: Order, _proof: Hex): Promise<boolean> {
    throw new Error('ZKVerifier not yet implemented')
  }
}
```

- [ ] **Step 6: 테스트 통과 확인**

```bash
npx vitest run test/unit/EIP712Verifier.test.ts
```

Expected: PASS (3/3)

- [ ] **Step 7: 커밋**

```bash
git add src/verification/ test/unit/EIP712Verifier.test.ts
git commit -m "feat: verification layer — EIP712Verifier with ZKVerifier stub"
```

---

## Task 5: Policy Engine + Plugins

**Files:**
- Create: `src/compliance/IPolicyPlugin.ts`
- Create: `src/compliance/PolicyEngine.ts`
- Create: `src/compliance/plugins/BasicBlocklistPlugin.ts`
- Create: `src/compliance/plugins/GeoBlockPlugin.ts`
- Create: `test/unit/PolicyEngine.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/PolicyEngine.test.ts`:
```typescript
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
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
npx vitest run test/unit/PolicyEngine.test.ts
```

Expected: FAIL — `Cannot find module`

- [ ] **Step 3: IPolicyPlugin 인터페이스 작성**

`src/compliance/IPolicyPlugin.ts`:
```typescript
import type { Address } from 'viem'

export interface TradeContext {
  maker:      Address
  taker:      Address
  baseToken:  Address
  quoteToken: Address
  amount:     bigint
  price:      bigint
  makerIp:    string
}

export interface PolicyResult {
  allowed: boolean
  reason?: string
}

export interface IPolicyPlugin {
  name: string
  check(ctx: TradeContext): Promise<PolicyResult>
}
```

- [ ] **Step 4: PolicyEngine 구현**

`src/compliance/PolicyEngine.ts`:
```typescript
import type { IPolicyPlugin, PolicyResult, TradeContext } from './IPolicyPlugin.js'

export class PolicyEngine {
  private readonly plugins: IPolicyPlugin[] = []

  register(plugin: IPolicyPlugin): void {
    this.plugins.push(plugin)
  }

  async check(ctx: TradeContext): Promise<PolicyResult> {
    for (const plugin of this.plugins) {
      const result = await plugin.check(ctx)
      if (!result.allowed) return result
    }
    return { allowed: true }
  }
}
```

- [ ] **Step 5: BasicBlocklistPlugin 구현**

`src/compliance/plugins/BasicBlocklistPlugin.ts`:
```typescript
import type { Address } from 'viem'
import type { IPolicyPlugin, PolicyResult, TradeContext } from '../IPolicyPlugin.js'

export class BasicBlocklistPlugin implements IPolicyPlugin {
  readonly name = 'BasicBlocklistPlugin'

  constructor(private readonly blocked: Set<Address>) {}

  async check(ctx: TradeContext): Promise<PolicyResult> {
    if (this.blocked.has(ctx.maker)) {
      return { allowed: false, reason: `Maker ${ctx.maker} is on the blocklist` }
    }
    if (this.blocked.has(ctx.taker)) {
      return { allowed: false, reason: `Taker ${ctx.taker} is on the blocklist` }
    }
    return { allowed: true }
  }
}
```

- [ ] **Step 6: GeoBlockPlugin 구현**

`src/compliance/plugins/GeoBlockPlugin.ts`:
```typescript
import geoip from 'geoip-lite'
import type { IPolicyPlugin, PolicyResult, TradeContext } from '../IPolicyPlugin.js'

export class GeoBlockPlugin implements IPolicyPlugin {
  readonly name = 'GeoBlockPlugin'

  constructor(private readonly blockedCountries: Set<string>) {}

  async check(ctx: TradeContext): Promise<PolicyResult> {
    if (!ctx.makerIp) return { allowed: true }
    const geo = geoip.lookup(ctx.makerIp)
    if (geo && this.blockedCountries.has(geo.country)) {
      return { allowed: false, reason: `Country ${geo.country} is geo-blocked` }
    }
    return { allowed: true }
  }
}
```

- [ ] **Step 7: 테스트 통과 확인**

```bash
npx vitest run test/unit/PolicyEngine.test.ts
```

Expected: PASS (5/5)

- [ ] **Step 8: 커밋**

```bash
git add src/compliance/ test/unit/PolicyEngine.test.ts
git commit -m "feat: compliance — PolicyEngine with BasicBlocklist and GeoBlock plugins"
```

---

## Task 6: OrderBook Store + Price-Time Matching

**Files:**
- Create: `src/core/orderbook/IOrderBookStore.ts`
- Create: `src/core/orderbook/MemoryOrderBookStore.ts`
- Create: `src/core/orderbook/OrderBook.ts`
- Create: `test/unit/MemoryOrderBookStore.test.ts`
- Create: `test/unit/OrderBook.test.ts`

- [ ] **Step 1: 인터페이스 작성**

`src/core/orderbook/IOrderBookStore.ts`:
```typescript
import type { OrderBookDepth, StoredOrder } from '../../types/order.js'

export interface IOrderBookStore {
  addOrder(order: StoredOrder): Promise<void>
  removeOrder(orderId: string): Promise<void>
  updateOrder(orderId: string, patch: Partial<StoredOrder>): Promise<void>
  getOrder(orderId: string): Promise<StoredOrder | undefined>
  getBestBid(pairId: string): Promise<StoredOrder | null>
  getBestAsk(pairId: string): Promise<StoredOrder | null>
  getOpenOrders(pairId: string, side: 'buy' | 'sell'): Promise<StoredOrder[]>
  getDepth(pairId: string, levels: number): Promise<OrderBookDepth>
  getOrdersByMaker(maker: string): Promise<StoredOrder[]>
}
```

- [ ] **Step 2: MemoryOrderBookStore 테스트 작성**

`test/unit/MemoryOrderBookStore.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import type { StoredOrder } from '../../src/types/order.js'

const PAIR = 'BASETOKEN/KRW'

function makeOrder(overrides: Partial<StoredOrder> = {}): StoredOrder {
  return {
    id:           uuid(),
    maker:        '0x1111111111111111111111111111111111111111',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price:        1350n * 10n ** 18n,
    amount:       1n * 10n ** 18n,
    isBuy:        true,
    nonce:        0n,
    expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '1.2.3.4',
    ...overrides,
  }
}

describe('MemoryOrderBookStore', () => {
  let store: MemoryOrderBookStore

  beforeEach(() => { store = new MemoryOrderBookStore() })

  it('adds and retrieves an order', async () => {
    const order = makeOrder()
    await store.addOrder(order)
    expect(await store.getOrder(order.id)).toMatchObject({ id: order.id })
  })

  it('removes an order', async () => {
    const order = makeOrder()
    await store.addOrder(order)
    await store.removeOrder(order.id)
    expect(await store.getOrder(order.id)).toBeUndefined()
  })

  it('getBestBid returns highest price bid', async () => {
    const low  = makeOrder({ id: uuid(), price: 1300n * 10n ** 18n, isBuy: true })
    const high = makeOrder({ id: uuid(), price: 1400n * 10n ** 18n, isBuy: true })
    await store.addOrder(low)
    await store.addOrder(high)
    const best = await store.getBestBid(PAIR)
    expect(best?.price).toBe(1400n * 10n ** 18n)
  })

  it('getBestAsk returns lowest price ask', async () => {
    const low  = makeOrder({ id: uuid(), price: 1300n * 10n ** 18n, isBuy: false })
    const high = makeOrder({ id: uuid(), price: 1400n * 10n ** 18n, isBuy: false })
    await store.addOrder(low)
    await store.addOrder(high)
    const best = await store.getBestAsk(PAIR)
    expect(best?.price).toBe(1300n * 10n ** 18n)
  })

  it('getDepth aggregates price levels', async () => {
    await store.addOrder(makeOrder({ id: uuid(), price: 1350n * 10n ** 18n, isBuy: true,  amount: 2n * 10n ** 18n }))
    await store.addOrder(makeOrder({ id: uuid(), price: 1350n * 10n ** 18n, isBuy: true,  amount: 3n * 10n ** 18n }))
    await store.addOrder(makeOrder({ id: uuid(), price: 1360n * 10n ** 18n, isBuy: false, amount: 1n * 10n ** 18n }))
    const depth = await store.getDepth(PAIR, 5)
    expect(depth.bids[0].amount).toBe(5n * 10n ** 18n)
    expect(depth.asks[0].price).toBe(1360n * 10n ** 18n)
  })
})
```

- [ ] **Step 3: 테스트 실패 확인**

```bash
npx vitest run test/unit/MemoryOrderBookStore.test.ts
```

Expected: FAIL — `Cannot find module`

- [ ] **Step 4: MemoryOrderBookStore 구현**

`src/core/orderbook/MemoryOrderBookStore.ts`:
```typescript
import type { OrderBookDepth, PriceLevel, StoredOrder } from '../../types/order.js'
import type { IOrderBookStore } from './IOrderBookStore.js'

// pairId = `${baseToken}/${quoteToken}` (checksummed addresses)
export class MemoryOrderBookStore implements IOrderBookStore {
  private readonly orders = new Map<string, StoredOrder>()

  async addOrder(order: StoredOrder): Promise<void> {
    this.orders.set(order.id, order)
  }

  async removeOrder(orderId: string): Promise<void> {
    this.orders.delete(orderId)
  }

  async updateOrder(orderId: string, patch: Partial<StoredOrder>): Promise<void> {
    const existing = this.orders.get(orderId)
    if (existing) this.orders.set(orderId, { ...existing, ...patch })
  }

  async getOrder(orderId: string): Promise<StoredOrder | undefined> {
    return this.orders.get(orderId)
  }

  async getBestBid(pairId: string): Promise<StoredOrder | null> {
    const [base, quote] = pairId.split('/')
    const bids = this.matchPair(base, quote).filter(o => o.isBuy && o.status === 'open')
    if (bids.length === 0) return null
    return bids.reduce((best, o) =>
      o.price > best.price || (o.price === best.price && o.submittedAt < best.submittedAt) ? o : best
    )
  }

  async getBestAsk(pairId: string): Promise<StoredOrder | null> {
    const [base, quote] = pairId.split('/')
    const asks = this.matchPair(base, quote).filter(o => !o.isBuy && o.status === 'open')
    if (asks.length === 0) return null
    return asks.reduce((best, o) =>
      o.price < best.price || (o.price === best.price && o.submittedAt < best.submittedAt) ? o : best
    )
  }

  async getOpenOrders(pairId: string, side: 'buy' | 'sell'): Promise<StoredOrder[]> {
    const [base, quote] = pairId.split('/')
    const isBuy = side === 'buy'
    return this.matchPair(base, quote)
      .filter(o => o.isBuy === isBuy && o.status === 'open')
      .sort((a, b) => {
        const priceDiff = isBuy
          ? Number(b.price - a.price)
          : Number(a.price - b.price)
        return priceDiff !== 0 ? priceDiff : a.submittedAt - b.submittedAt
      })
  }

  async getDepth(pairId: string, levels: number): Promise<OrderBookDepth> {
    const bids = await this.getOpenOrders(pairId, 'buy')
    const asks = await this.getOpenOrders(pairId, 'sell')

    return {
      pairId,
      bids: this.aggregate(bids, levels),
      asks: this.aggregate(asks, levels),
      timestamp: Date.now(),
    }
  }

  async getOrdersByMaker(maker: string): Promise<StoredOrder[]> {
    const m = maker.toLowerCase()
    return [...this.orders.values()].filter(o => o.maker.toLowerCase() === m)
  }

  private matchPair(base: string, quote: string): StoredOrder[] {
    const b = base.toLowerCase()
    const q = quote.toLowerCase()
    return [...this.orders.values()].filter(
      o => o.baseToken.toLowerCase() === b && o.quoteToken.toLowerCase() === q,
    )
  }

  private aggregate(orders: StoredOrder[], levels: number): PriceLevel[] {
    const map = new Map<bigint, { amount: bigint; count: number }>()
    for (const o of orders) {
      const remaining = o.amount - o.filledAmount
      if (remaining <= 0n) continue
      const entry = map.get(o.price) ?? { amount: 0n, count: 0 }
      entry.amount += remaining
      entry.count++
      map.set(o.price, entry)
    }
    return [...map.entries()]
      .slice(0, levels)
      .map(([price, { amount, count }]) => ({ price, amount, orderCount: count }))
  }
}
```

- [ ] **Step 5: MemoryOrderBookStore 테스트 통과 확인**

```bash
npx vitest run test/unit/MemoryOrderBookStore.test.ts
```

Expected: PASS (5/5)

- [ ] **Step 6: OrderBook 매칭 로직 테스트 작성**

`test/unit/OrderBook.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { v4 as uuid } from 'uuid'
import { OrderBook } from '../../src/core/orderbook/OrderBook.js'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import type { StoredOrder } from '../../src/types/order.js'

const PAIR = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'

function makeOrder(isBuy: boolean, price: bigint, amount: bigint = 1n * 10n ** 18n): StoredOrder {
  return {
    id:           uuid(),
    maker:        isBuy
                    ? '0x1111111111111111111111111111111111111111'
                    : '0x2222222222222222222222222222222222222222',
    taker:        '0x0000000000000000000000000000000000000000',
    baseToken:    '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    quoteToken:   '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    price, amount, isBuy,
    nonce:        0n,
    expiry:       BigInt(Math.floor(Date.now() / 1000) + 3600),
    signature:    '0x',
    submittedAt:  Date.now(),
    filledAmount: 0n,
    status:       'open',
    makerIp:      '1.2.3.4',
  }
}

describe('OrderBook', () => {
  let ob: OrderBook

  beforeEach(() => {
    ob = new OrderBook(new MemoryOrderBookStore(), PAIR)
  })

  it('returns no matches when only bids', async () => {
    const bid = makeOrder(true, 1350n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(0)
  })

  it('matches bid and ask at same price', async () => {
    const ask = makeOrder(false, 1350n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1350n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(1n * 10n ** 18n)
  })

  it('matches bid against lower-priced ask (bid price >= ask price)', async () => {
    const ask = makeOrder(false, 1300n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1400n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    // execution at ask price (maker price)
    expect(matches[0].price).toBe(1300n * 10n ** 18n)
  })

  it('does not match when bid < ask', async () => {
    const ask = makeOrder(false, 1400n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true, 1300n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(0)
  })

  it('partial fill: bid larger than ask leaves remainder in book', async () => {
    const ask = makeOrder(false, 1350n * 10n ** 18n, 1n * 10n ** 18n)
    await ob.submit(ask)
    const bid = makeOrder(true,  1350n * 10n ** 18n, 3n * 10n ** 18n)
    const matches = await ob.submit(bid)
    expect(matches).toHaveLength(1)
    expect(matches[0].fillAmount).toBe(1n * 10n ** 18n)
    // bid still in book with 2e18 remaining
    const depth = await ob.getDepth(5)
    expect(depth.bids[0].amount).toBe(2n * 10n ** 18n)
  })
})
```

- [ ] **Step 7: OrderBook 구현**

`src/core/orderbook/OrderBook.ts`:
```typescript
import type { MatchResult, StoredOrder } from '../../types/order.js'
import type { IOrderBookStore } from './IOrderBookStore.js'
import type { OrderBookDepth } from '../../types/order.js'

export class OrderBook {
  constructor(
    private readonly store: IOrderBookStore,
    private readonly pairId: string,
  ) {}

  // Submit an order, run matching, return all matches produced
  async submit(order: StoredOrder): Promise<MatchResult[]> {
    await this.store.addOrder(order)
    return this.runMatching(order)
  }

  async getDepth(levels: number): Promise<OrderBookDepth> {
    return this.store.getDepth(this.pairId, levels)
  }

  async removeOrder(orderId: string): Promise<void> {
    await this.store.removeOrder(orderId)
  }

  private async runMatching(incoming: StoredOrder): Promise<MatchResult[]> {
    const results: MatchResult[] = []

    while (true) {
      const incoming_ = await this.store.getOrder(incoming.id)
      if (!incoming_ || incoming_.status !== 'open') break

      const remaining = incoming_.amount - incoming_.filledAmount
      if (remaining <= 0n) break

      // Find counterparty
      const counter = incoming_.isBuy
        ? await this.store.getBestAsk(this.pairId)
        : await this.store.getBestBid(this.pairId)

      if (!counter || counter.id === incoming_.id) break

      // Price check: buy price must be >= sell price
      const bid = incoming_.isBuy ? incoming_ : counter
      const ask = incoming_.isBuy ? counter   : incoming_

      if (bid.price < ask.price) break

      // Fill at maker (ask) price
      const execPrice   = ask.maker === counter.maker ? counter.price : incoming_.price
      const counterRem  = counter.amount - counter.filledAmount
      const fillAmount  = remaining < counterRem ? remaining : counterRem

      // Update both orders
      const newIncomingFill = incoming_.filledAmount + fillAmount
      const newCounterFill  = counter.filledAmount  + fillAmount

      await this.store.updateOrder(incoming_.id, {
        filledAmount: newIncomingFill,
        status: newIncomingFill >= incoming_.amount ? 'filled' : 'partial',
      })
      await this.store.updateOrder(counter.id, {
        filledAmount: newCounterFill,
        status: newCounterFill >= counter.amount ? 'filled' : 'partial',
      })

      const makerOrder = incoming_.isBuy ? counter    : incoming_
      const takerOrder = incoming_.isBuy ? incoming_  : counter

      results.push({
        makerOrder, takerOrder,
        fillAmount,
        price: execPrice,
        matchedAt: Date.now(),
      })
    }

    return results
  }
}
```

- [ ] **Step 8: 테스트 통과 확인**

```bash
npx vitest run test/unit/OrderBook.test.ts test/unit/MemoryOrderBookStore.test.ts
```

Expected: PASS (10/10)

- [ ] **Step 9: 커밋**

```bash
git add src/core/orderbook/ test/unit/MemoryOrderBookStore.test.ts test/unit/OrderBook.test.ts
git commit -m "feat: orderbook — IOrderBookStore, MemoryOrderBookStore, price-time matching"
```

---

## Task 7: MatchingEngine

**Files:**
- Create: `src/core/matching/MatchingEngine.ts`

- [ ] **Step 1: MatchingEngine 구현**

`src/core/matching/MatchingEngine.ts`:
```typescript
import { EventEmitter } from 'events'
import type { MatchResult, StoredOrder } from '../../types/order.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'
import { OrderBook } from '../orderbook/OrderBook.js'

// Events emitted:
//   'matched'  (result: MatchResult)    — one per fill
//   'rejected' (orderId, reason)        — pair not active / pre-check fail
export class MatchingEngine extends EventEmitter {
  private readonly orderbooks = new Map<string, OrderBook>()

  constructor(private readonly store: IOrderBookStore) {
    super()
  }

  private getOrCreateBook(pairId: string): OrderBook {
    let book = this.orderbooks.get(pairId)
    if (!book) {
      book = new OrderBook(this.store, pairId)
      this.orderbooks.set(pairId, book)
    }
    return book
  }

  async submitOrder(order: StoredOrder, pairId: string): Promise<void> {
    const book = this.getOrCreateBook(pairId)
    const matches = await book.submit(order)
    for (const match of matches) {
      this.emit('matched', match)
    }
  }

  async cancelOrder(orderId: string, pairId: string): Promise<void> {
    const book = this.getOrCreateBook(pairId)
    await book.removeOrder(orderId)
  }

  async getDepth(pairId: string, levels = 20) {
    return this.getOrCreateBook(pairId).getDepth(levels)
  }
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/core/matching/MatchingEngine.ts
git commit -m "feat: MatchingEngine — EventEmitter based order routing"
```

---

## Task 8: SettlementWorker

**Files:**
- Create: `src/core/settlement/SettlementWorker.ts`
- Create: `test/unit/SettlementWorker.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/unit/SettlementWorker.test.ts`:
```typescript
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
```

- [ ] **Step 2: 테스트 실패 확인**

```bash
npx vitest run test/unit/SettlementWorker.test.ts
```

Expected: FAIL — `Cannot find module`

- [ ] **Step 3: SettlementWorker 구현**

`src/core/settlement/SettlementWorker.ts`:
```typescript
import { EventEmitter } from 'events'
import type { MatchResult } from '../../types/order.js'

export interface SettlementWorkerOptions {
  batchSize:      number
  batchTimeoutMs: number
  settle:         (batch: MatchResult[]) => Promise<string>  // returns txHash
}

// Events:
//   'settled'  (batch: MatchResult[], txHash: string)
//   'error'    (batch: MatchResult[], err: Error)
export class SettlementWorker extends EventEmitter {
  private queue: MatchResult[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: SettlementWorkerOptions) {
    super()
    this.scheduleTimer()
  }

  enqueue(match: MatchResult): void {
    this.queue.push(match)
    if (this.queue.length >= this.opts.batchSize) {
      this.flush()
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleTimer(): void {
    this.timer = setTimeout(() => {
      this.flush()
      this.scheduleTimer()
    }, this.opts.batchTimeoutMs)
  }

  private flush(): void {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    this.opts.settle(batch)
      .then(txHash => this.emit('settled', batch, txHash))
      .catch(err   => this.emit('error',   batch, err))
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

```bash
npx vitest run test/unit/SettlementWorker.test.ts
```

Expected: PASS (3/3)

- [ ] **Step 5: settleBatch 호출 함수 작성**

`src/core/settlement/settleBatch.ts`:
```typescript
import type { WalletClient, Address, Hex } from 'viem'
import { ORDER_SETTLEMENT_ABI } from '../../chain/abis.js'
import type { MatchResult } from '../../types/order.js'

export async function settleBatch(
  walletClient: WalletClient,
  contractAddress: Address,
  batch: MatchResult[],
): Promise<Hex> {
  if (batch.length === 0) throw new Error('Empty batch')

  // Group by taker order: one taker, multiple makers
  // For MVP: treat each match as single-maker-single-taker (settle one taker per batch)
  // Production: group by takerOrder.id for true batch efficiency
  const takerOrder   = batch[0].takerOrder
  const takerSig     = batch[0].takerOrder.signature
  const makerOrders  = batch.map(m => m.makerOrder)
  const makerSigs    = batch.map(m => m.makerOrder.signature)
  const fillAmounts  = batch.map(m => m.fillAmount)

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: ORDER_SETTLEMENT_ABI,
    functionName: 'settleBatch',
    args: [
      makerOrders.map(o => ({
        maker: o.maker, taker: o.taker,
        baseToken: o.baseToken, quoteToken: o.quoteToken,
        price: o.price, amount: o.amount, isBuy: o.isBuy,
        nonce: o.nonce, expiry: o.expiry,
      })),
      {
        maker: takerOrder.maker, taker: takerOrder.taker,
        baseToken: takerOrder.baseToken, quoteToken: takerOrder.quoteToken,
        price: takerOrder.price, amount: takerOrder.amount, isBuy: takerOrder.isBuy,
        nonce: takerOrder.nonce, expiry: takerOrder.expiry,
      },
      fillAmounts,
      makerSigs,
      takerSig,
    ],
  })

  return hash
}
```

- [ ] **Step 6: 커밋**

```bash
git add src/core/settlement/ test/unit/SettlementWorker.test.ts
git commit -m "feat: SettlementWorker — batch queue with timer/count triggers"
```

---

## Task 9: ChainWatcher

**Files:**
- Create: `src/core/watcher/ChainWatcher.ts`

- [ ] **Step 1: ChainWatcher 구현**

`src/core/watcher/ChainWatcher.ts`:
```typescript
import { EventEmitter } from 'events'
import type { PublicClient, Address } from 'viem'
import { ORDER_SETTLEMENT_ABI } from '../../chain/abis.js'
import type { IOrderBookStore } from '../orderbook/IOrderBookStore.js'

// Events:
//   'orderFilled'    (maker, taker, baseToken, fillAmount, fee)
//   'orderCancelled' (user, nonce)
export class ChainWatcher extends EventEmitter {
  private unwatchFilled:    (() => void) | null = null
  private unwatchCancelled: (() => void) | null = null

  constructor(
    private readonly publicClient: PublicClient,
    private readonly contractAddress: Address,
    private readonly store: IOrderBookStore,
  ) {
    super()
  }

  start(): void {
    this.unwatchFilled = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: ORDER_SETTLEMENT_ABI,
      eventName: 'OrderFilled',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { maker, taker, baseToken, fillAmount, fee } = log.args as {
            maker: Address; taker: Address; baseToken: Address
            fillAmount: bigint; fee: bigint
          }
          this.emit('orderFilled', { maker, taker, baseToken, fillAmount, fee })
        }
      },
    })

    this.unwatchCancelled = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: ORDER_SETTLEMENT_ABI,
      eventName: 'OrderCancelled',
      onLogs: async (logs) => {
        for (const log of logs) {
          const { user, nonce } = log.args as { user: Address; nonce: bigint }
          // Remove matching open orders from store
          const orders = await this.store.getOrdersByMaker(user)
          for (const o of orders) {
            if (o.nonce === nonce) {
              await this.store.updateOrder(o.id, { status: 'cancelled' })
            }
          }
          this.emit('orderCancelled', { user, nonce })
        }
      },
    })
  }

  stop(): void {
    this.unwatchFilled?.()
    this.unwatchCancelled?.()
  }
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/core/watcher/ChainWatcher.ts
git commit -m "feat: ChainWatcher — OrderFilled / OrderCancelled event sync"
```

---

## Task 10: REST API Routes

**Files:**
- Create: `src/api/routes/orders.ts`
- Create: `src/api/routes/orderbook.ts`
- Create: `src/api/routes/trades.ts`

- [ ] **Step 1: orders.ts 작성**

`src/api/routes/orders.ts`:
```typescript
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import type { IOrderVerifier } from '../../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../../core/orderbook/IOrderBookStore.js'
import type { Order, StoredOrder } from '../../types/order.js'
import type { Hex, Address } from 'viem'

interface SubmitOrderBody {
  order:     Order
  signature: Hex
  makerIp?:  string
}

interface CancelOrderParams {
  nonce: string
}
interface CancelOrderBody {
  maker: Address
}

export function ordersRoutes(
  verifier:      IOrderVerifier,
  policy:        PolicyEngine,
  matching:      MatchingEngine,
  store:         IOrderBookStore,
  pairRegistry:  { read: { isTradeAllowed: (args: { args: [Address, Address] }) => Promise<boolean> } },
) {
  return async function (fastify: FastifyInstance) {
    // POST /orders — submit a signed order
    fastify.post<{ Body: SubmitOrderBody }>('/orders', async (req, reply) => {
      const { order, signature, makerIp = req.ip } = req.body

      // 1. Expiry check
      const now = BigInt(Math.floor(Date.now() / 1000))
      if (order.expiry <= now) {
        return reply.status(400).send({ error: 'Order expired' })
      }

      // 2. EIP-712 signature verification
      const valid = await verifier.verify(order, signature)
      if (!valid) {
        return reply.status(400).send({ error: 'Invalid signature' })
      }

      // 3. PairRegistry check — reject if pair is not active
      const tradeAllowed = await pairRegistry.read.isTradeAllowed({ args: [order.baseToken, order.quoteToken] })
      if (!tradeAllowed) {
        return reply.status(400).send({ error: 'Trading pair not active' })
      }

      // 4. Policy check (fail-closed)
      const policyResult = await policy.check({
        maker:      order.maker,
        taker:      order.taker,
        baseToken:  order.baseToken,
        quoteToken: order.quoteToken,
        amount:     order.amount,
        price:      order.price,
        makerIp,
      })
      if (!policyResult.allowed) {
        return reply.status(403).send({ error: policyResult.reason ?? 'Compliance check failed' })
      }

      // 4. Store and match
      const stored: StoredOrder = {
        ...order,
        id:           uuid(),
        signature,
        submittedAt:  Date.now(),
        filledAmount: 0n,
        status:       'open',
        makerIp,
      }

      const pairId = `${order.baseToken}/${order.quoteToken}`
      await matching.submitOrder(stored, pairId)

      return reply.status(201).send({ orderId: stored.id })
    })

    // DELETE /orders/:nonce — cancel an order
    fastify.delete<{ Params: CancelOrderParams; Body: CancelOrderBody }>(
      '/orders/:nonce',
      async (req, reply) => {
        const { maker } = req.body
        const nonce = BigInt(req.params.nonce)

        const orders = await store.getOrdersByMaker(maker)
        const target = orders.find(o => o.nonce === nonce && o.status === 'open')
        if (!target) {
          return reply.status(404).send({ error: 'Order not found' })
        }

        await store.updateOrder(target.id, { status: 'cancelled' })
        return reply.send({ cancelled: true })
      },
    )

    // GET /orders/:address — open orders for a maker
    fastify.get<{ Params: { address: string } }>('/orders/:address', async (req, reply) => {
      const orders = await store.getOrdersByMaker(req.params.address)
      return reply.send({ orders: orders.filter(o => o.status === 'open') })
    })
  }
}
```

- [ ] **Step 2: orderbook.ts 작성**

`src/api/routes/orderbook.ts`:
```typescript
import type { FastifyInstance } from 'fastify'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'

export function orderbookRoutes(matching: MatchingEngine) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/orderbook/:pair', async (req, reply) => {
      const pairId = decodeURIComponent(req.params.pair)
      const depth  = await matching.getDepth(pairId, 20)
      // Serialize bigints for JSON
      return reply.send({
        pairId:    depth.pairId,
        timestamp: depth.timestamp,
        bids: depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString(), orderCount: l.orderCount })),
        asks: depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString(), orderCount: l.orderCount })),
      })
    })
  }
}
```

- [ ] **Step 3: trades.ts 작성**

`src/api/routes/trades.ts`:
```typescript
import type { FastifyInstance } from 'fastify'
import type { TradeRecord } from '../../types/order.js'

// In-memory trade history (production: move to DB)
export class TradeStore {
  private readonly trades = new Map<string, TradeRecord[]>()

  add(pairId: string, trade: TradeRecord): void {
    const list = this.trades.get(pairId) ?? []
    list.unshift(trade)                   // newest first
    if (list.length > 500) list.pop()     // cap at 500
    this.trades.set(pairId, list)
  }

  get(pairId: string, limit = 50): TradeRecord[] {
    return (this.trades.get(pairId) ?? []).slice(0, limit)
  }
}

export function tradesRoutes(tradeStore: TradeStore) {
  return async function (fastify: FastifyInstance) {
    fastify.get<{ Params: { pair: string } }>('/trades/:pair', async (req, reply) => {
      const pairId = decodeURIComponent(req.params.pair)
      const trades = tradeStore.get(pairId, 50)
      return reply.send({
        trades: trades.map(t => ({
          ...t,
          price:  t.price.toString(),
          amount: t.amount.toString(),
        })),
      })
    })
  }
}
```

- [ ] **Step 4: 커밋**

```bash
git add src/api/routes/
git commit -m "feat: REST API routes — orders, orderbook, trades"
```

---

## Task 11: WebSocket Stream

**Files:**
- Create: `src/api/websocket/stream.ts`

- [ ] **Step 1: WebSocket 스트림 구현**

`src/api/websocket/stream.ts`:
```typescript
import type { FastifyInstance } from 'fastify'
import type { MatchingEngine } from '../../core/matching/MatchingEngine.js'
import type { MatchResult } from '../../types/order.js'
import type { TradeStore } from '../routes/trades.js'

function serializeMatch(match: MatchResult) {
  return {
    price:      match.price.toString(),
    amount:     match.fillAmount.toString(),
    maker:      match.makerOrder.maker,
    taker:      match.takerOrder.maker,
    tradedAt:   match.matchedAt,
  }
}

export function streamRoutes(matching: MatchingEngine, tradeStore: TradeStore) {
  return async function (fastify: FastifyInstance) {
    fastify.get('/stream', { websocket: true }, (socket, req) => {
      // 1. Send current orderbook snapshot for all pairs on connect
      // (Client specifies pair via query param: /stream?pair=BASE/QUOTE)
      const pairId = (req.query as Record<string, string>).pair
      if (!pairId) {
        socket.send(JSON.stringify({ type: 'error', message: 'pair query param required' }))
        socket.close()
        return
      }

      // Send snapshot immediately
      matching.getDepth(pairId, 20).then(depth => {
        socket.send(JSON.stringify({
          type: 'orderbook.snapshot',
          data: {
            pairId:    depth.pairId,
            timestamp: depth.timestamp,
            bids: depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
            asks: depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
          },
        }))
      })

      // 2. Stream live matches as trade events + order status updates
      const onMatched = (match: MatchResult) => {
        const matchPairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
        if (matchPairId !== pairId) return
        if (socket.readyState !== 1 /* OPEN */) return

        socket.send(JSON.stringify({
          type: 'trades.recent',
          data: serializeMatch(match),
        }))

        // Push order.status for maker and taker orders
        socket.send(JSON.stringify({
          type: 'order.status',
          data: {
            orderId: match.makerOrder.id,
            maker:   match.makerOrder.maker,
            status:  match.makerOrder.status,
            filledAmount: match.makerOrder.filledAmount.toString(),
          },
        }))
        socket.send(JSON.stringify({
          type: 'order.status',
          data: {
            orderId: match.takerOrder.id,
            maker:   match.takerOrder.maker,
            status:  match.takerOrder.status,
            filledAmount: match.takerOrder.filledAmount.toString(),
          },
        }))

        // Also push updated depth
        matching.getDepth(pairId, 20).then(depth => {
          if (socket.readyState !== 1) return
          socket.send(JSON.stringify({
            type: 'orderbook.update',
            data: {
              bids: depth.bids.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
              asks: depth.asks.map(l => ({ price: l.price.toString(), amount: l.amount.toString() })),
              timestamp: depth.timestamp,
            },
          }))
        })
      }

      matching.on('matched', onMatched)

      socket.on('close', () => {
        matching.off('matched', onMatched)
      })
    })
  }
}
```

- [ ] **Step 2: 커밋**

```bash
git add src/api/websocket/stream.ts
git commit -m "feat: WebSocket stream — orderbook snapshot + live trade events"
```

---

## Task 12: Server Assembly + Integration Test

**Files:**
- Create: `src/api/server.ts`
- Create: `src/index.ts`
- Create: `test/integration/api.test.ts`

- [ ] **Step 1: server.ts 작성**

`src/api/server.ts`:
```typescript
import Fastify from 'fastify'
import fastifyWebSocket from '@fastify/websocket'
import fastifyCors from '@fastify/cors'
import fastifyRateLimit from '@fastify/rate-limit'
import type { Config } from '../config/config.js'
import type { Clients } from '../chain/contracts.js'
import type { IOrderVerifier } from '../verification/IOrderVerifier.js'
import type { PolicyEngine } from '../compliance/PolicyEngine.js'
import type { MatchingEngine } from '../core/matching/MatchingEngine.js'
import type { IOrderBookStore } from '../core/orderbook/IOrderBookStore.js'
import { ordersRoutes } from './routes/orders.js'
import { orderbookRoutes } from './routes/orderbook.js'
import { tradesRoutes, TradeStore } from './routes/trades.js'
import { streamRoutes } from './websocket/stream.js'

export function buildServer(deps: {
  config:       Config
  verifier:     IOrderVerifier
  policy:       PolicyEngine
  matching:     MatchingEngine
  store:        IOrderBookStore
  trades:       TradeStore
  pairRegistry: Clients['pairRegistry']
}) {
  const { config, verifier, policy, matching, store, trades, pairRegistry } = deps
  const fastify = Fastify({ logger: true })

  fastify.register(fastifyCors,      { origin: true })
  fastify.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' })
  fastify.register(fastifyWebSocket)

  fastify.register(ordersRoutes(verifier, policy, matching, store, pairRegistry))
  fastify.register(orderbookRoutes(matching))
  fastify.register(tradesRoutes(trades))
  fastify.register(streamRoutes(matching, trades))

  fastify.get('/health', async () => ({ status: 'ok', ts: Date.now() }))

  return fastify
}
```

- [ ] **Step 2: index.ts 작성**

`src/index.ts`:
```typescript
import 'dotenv/config'
import { loadConfig } from './config/config.js'
import { createClients } from './chain/contracts.js'
import { createOperatorWallet } from './chain/wallet.js'
import { EIP712Verifier } from './verification/EIP712Verifier.js'
import { PolicyEngine } from './compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from './compliance/plugins/BasicBlocklistPlugin.js'
import { GeoBlockPlugin } from './compliance/plugins/GeoBlockPlugin.js'
import { MemoryOrderBookStore } from './core/orderbook/MemoryOrderBookStore.js'
import { MatchingEngine } from './core/matching/MatchingEngine.js'
import { SettlementWorker } from './core/settlement/SettlementWorker.js'
import { settleBatch } from './core/settlement/settleBatch.js'
import { ChainWatcher } from './core/watcher/ChainWatcher.js'
import { TradeStore } from './api/routes/trades.js'
import { buildServer } from './api/server.js'

const config = loadConfig()
const { publicClient, pairRegistry } = createClients(config)
const { walletClient } = createOperatorWallet(config)

const domain = {
  name: 'KRW DEX' as const,
  version: '1' as const,
  chainId: BigInt(config.chainId),
  verifyingContract: config.orderSettlementAddress,
}

const verifier  = new EIP712Verifier(domain)
const policy    = new PolicyEngine()
const store     = new MemoryOrderBookStore()
const trades    = new TradeStore()
const matching  = new MatchingEngine(store)

policy.register(new BasicBlocklistPlugin(new Set()))
policy.register(new GeoBlockPlugin(new Set(config.blockedCountries)))

const worker = new SettlementWorker({
  batchSize:      config.batchSize,
  batchTimeoutMs: config.batchTimeoutMs,
  settle: (batch) => settleBatch(walletClient, config.orderSettlementAddress, batch),
})

matching.on('matched', (match) => {
  worker.enqueue(match)
  const pairId = `${match.makerOrder.baseToken}/${match.makerOrder.quoteToken}`
  trades.add(pairId, {
    id:           `${match.makerOrder.id}-${match.takerOrder.id}`,
    pairId,
    price:        match.price,
    amount:       match.fillAmount,
    isBuyerMaker: match.makerOrder.isBuy,
    tradedAt:     match.matchedAt,
  })
})

worker.on('settled', (_batch, txHash) => console.log('Settled:', txHash))
worker.on('error',   (_batch, err)    => console.error('Settlement error:', err))

const watcher = new ChainWatcher(publicClient, config.orderSettlementAddress, store)
watcher.start()

const server = buildServer({ config, verifier, policy, matching, store, trades, pairRegistry })

server.listen({ port: config.port, host: config.host }, (err) => {
  if (err) { console.error(err); process.exit(1) }
})

process.on('SIGTERM', async () => {
  worker.stop()
  watcher.stop()
  await server.close()
  process.exit(0)
})
```

- [ ] **Step 3: 빌드 확인**

```bash
npx tsc --noEmit
```

Expected: 타입 에러 0개

- [ ] **Step 4: Integration 테스트 작성**

`test/integration/api.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { buildServer } from '../../src/api/server.js'
import { EIP712Verifier } from '../../src/verification/EIP712Verifier.js'
import { PolicyEngine } from '../../src/compliance/PolicyEngine.js'
import { BasicBlocklistPlugin } from '../../src/compliance/plugins/BasicBlocklistPlugin.js'
import { MemoryOrderBookStore } from '../../src/core/orderbook/MemoryOrderBookStore.js'
import { MatchingEngine } from '../../src/core/matching/MatchingEngine.js'
import { TradeStore } from '../../src/api/routes/trades.js'
import type { Order } from '../../src/types/order.js'

const BASE  = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address
const QUOTE = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as Address
const CONTRACT = '0x0000000000000000000000000000000000000001' as Address
const CHAIN_ID  = 1337n

const DOMAIN = { name: 'KRW DEX' as const, version: '1' as const, chainId: CHAIN_ID, verifyingContract: CONTRACT }
const TYPES  = {
  Order: [
    { name: 'maker', type: 'address' }, { name: 'taker', type: 'address' },
    { name: 'baseToken', type: 'address' }, { name: 'quoteToken', type: 'address' },
    { name: 'price', type: 'uint256' }, { name: 'amount', type: 'uint256' },
    { name: 'isBuy', type: 'bool' }, { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
} as const

async function signOrder(pk: `0x${string}`, order: Order) {
  const account = privateKeyToAccount(pk)
  return account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Order', message: order })
}

describe('API Integration', () => {
  const pk1  = generatePrivateKey()
  const acc1 = privateKeyToAccount(pk1)

  let server: ReturnType<typeof buildServer>
  let store:  MemoryOrderBookStore

  beforeAll(async () => {
    store = new MemoryOrderBookStore()
    const matching = new MatchingEngine(store)
    const policy   = new PolicyEngine()
    policy.register(new BasicBlocklistPlugin(new Set()))

    // Mock pairRegistry: always returns true (all pairs allowed in tests)
    const pairRegistry = {
      read: {
        isTradeAllowed: async () => true,
      },
    } as any

    server = buildServer({
      config:   { batchSize: 10, batchTimeoutMs: 1000 } as any,
      verifier: new EIP712Verifier(DOMAIN),
      policy, matching, store,
      trades:       new TradeStore(),
      pairRegistry,
    })
    await server.ready()
  })

  afterAll(() => server.close())

  it('POST /orders returns 201 for valid signed order', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 0n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }
    const sig = await signOrder(pk1, order)
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: sig }),
    })
    expect(res.statusCode).toBe(201)
    expect(JSON.parse(res.body)).toHaveProperty('orderId')
  })

  it('POST /orders returns 400 for expired order', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 1n, expiry: 1n,
    }
    const sig = await signOrder(pk1, order)
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: sig }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /orders returns 400 for invalid signature', async () => {
    const order: Order = {
      maker: acc1.address, taker: '0x0000000000000000000000000000000000000000',
      baseToken: BASE, quoteToken: QUOTE,
      price: 1350n * 10n**18n, amount: 1n * 10n**18n, isBuy: true,
      nonce: 2n, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    }
    const res = await server.inject({
      method: 'POST', url: '/orders',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order, signature: '0xdeadbeef' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('GET /orderbook/:pair returns depth', async () => {
    const pair = encodeURIComponent(`${BASE}/${QUOTE}`)
    const res  = await server.inject({ method: 'GET', url: `/orderbook/${pair}` })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body).toHaveProperty('bids')
    expect(body).toHaveProperty('asks')
  })

  it('GET /health returns ok', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('ok')
  })
})
```

- [ ] **Step 5: 전체 테스트 실행**

```bash
npx vitest run
```

Expected: PASS (모든 단위 테스트 + 통합 테스트)

- [ ] **Step 6: 커밋**

```bash
git add src/api/server.ts src/index.ts test/integration/api.test.ts
git commit -m "feat: server assembly and integration tests"
```

---

## Task 13: dotenv + 최종 확인

**Files:**
- Modify: `package.json` (dotenv 추가)

- [ ] **Step 1: dotenv 설치**

```bash
npm install dotenv
```

- [ ] **Step 2: 전체 테스트 + 타입 체크**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: 타입 에러 0, 테스트 전체 PASS

- [ ] **Step 3: 개발 서버 실행 확인 (옵션 — .env 파일 있을 때)**

```bash
# .env 파일에 실제 값 입력 후:
npm run dev
```

Expected: `Server listening at http://0.0.0.0:3000`

- [ ] **Step 4: 최종 커밋**

```bash
git add package.json package-lock.json
git commit -m "chore: add dotenv, finalize project"
```

---

## Task 14: Admin Auth Middleware + Config 업데이트

**Files:**
- Modify: `src/config/config.ts` — adminApiKey 필드 추가
- Modify: `.env.example` — ADMIN_API_KEY 추가
- Create: `src/admin/auth.ts` — Bearer 토큰 미들웨어

- [ ] **Step 1: Config에 adminApiKey 추가**

`src/config/config.ts`의 Config 인터페이스에 추가:
```typescript
adminApiKey: string
```

`loadConfig()` 함수에 추가:
```typescript
adminApiKey: requireEnv('ADMIN_API_KEY'),
```

- [ ] **Step 2: .env.example에 추가**

```bash
# Admin API
ADMIN_API_KEY=change-me-in-production
```

- [ ] **Step 3: Admin auth 미들웨어 작성**

`src/admin/auth.ts`:
```typescript
import type { FastifyRequest, FastifyReply } from 'fastify'

export function createAdminAuth(adminApiKey: string) {
  return async function adminAuth(req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers['authorization']
    if (!auth || auth !== `Bearer ${adminApiKey}`) {
      return reply.status(401).send({ error: 'Unauthorized' })
    }
  }
}
```

- [ ] **Step 4: tsc 체크 후 커밋**

```bash
npx tsc --noEmit
git add src/config/config.ts .env.example src/admin/auth.ts
git commit -m "feat: admin auth middleware — Bearer API key"
```

---

## Task 15: Admin API Routes

**Files:**
- Create: `src/admin/routes.ts`

- [ ] **Step 1: Admin routes 작성**

`src/admin/routes.ts`:
```typescript
import type { FastifyInstance } from 'fastify'
import type { Address } from 'viem'
import type { Config } from '../config/config.js'
import type { MatchingEngine } from '../core/matching/MatchingEngine.js'
import type { SettlementWorker } from '../core/settlement/SettlementWorker.js'
import type { IOrderBookStore } from '../core/orderbook/IOrderBookStore.js'
import type { BasicBlocklistPlugin } from '../compliance/plugins/BasicBlocklistPlugin.js'
import { createAdminAuth } from './auth.js'

export interface AdminDeps {
  config:     Config
  matching:   MatchingEngine
  worker:     SettlementWorker
  store:      IOrderBookStore
  blocklist:  BasicBlocklistPlugin
}

export function adminRoutes(deps: AdminDeps) {
  return async function (fastify: FastifyInstance) {
    const auth = createAdminAuth(deps.config.adminApiKey)

    // Apply auth to all admin routes
    fastify.addHook('preHandler', auth)

    // GET /admin/stats — 서버 상태 조회
    fastify.get('/admin/stats', async (_req, reply) => {
      const stats = {
        uptime:      process.uptime(),
        memoryMB:    Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        queueSize:   (deps.worker as any).queue?.length ?? 0,
        timestamp:   Date.now(),
      }
      return reply.send(stats)
    })

    // GET /admin/blocklist — 차단 주소 목록 조회
    fastify.get('/admin/blocklist', async (_req, reply) => {
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      return reply.send({ blocked: [...blocked] })
    })

    // POST /admin/blocklist — 주소 차단 추가
    fastify.post<{ Body: { address: Address } }>('/admin/blocklist', async (req, reply) => {
      const { address } = req.body
      if (!address) return reply.status(400).send({ error: 'address required' })
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      blocked.add(address.toLowerCase() as Address)
      return reply.send({ added: address })
    })

    // DELETE /admin/blocklist/:address — 차단 해제
    fastify.delete<{ Params: { address: string } }>('/admin/blocklist/:address', async (req, reply) => {
      const addr = req.params.address.toLowerCase() as Address
      const blocked = (deps.blocklist as any).blocked as Set<Address>
      blocked.delete(addr)
      return reply.send({ removed: addr })
    })

    // POST /admin/pause — 매칭 일시 중단
    fastify.post('/admin/pause', async (_req, reply) => {
      (deps.matching as any)._paused = true
      return reply.send({ status: 'paused' })
    })

    // POST /admin/resume — 매칭 재개
    fastify.post('/admin/resume', async (_req, reply) => {
      (deps.matching as any)._paused = false
      return reply.send({ status: 'resumed' })
    })
  }
}
```

**Note:** MatchingEngine의 `submitOrder`에 pause 체크 추가 필요:
```typescript
// src/core/matching/MatchingEngine.ts 의 submitOrder 첫 줄에 추가:
async submitOrder(order: StoredOrder, pairId: string): Promise<void> {
  if ((this as any)._paused) {
    this.emit('rejected', order.id, 'Server paused')
    return
  }
  // ... 기존 코드
}
```

- [ ] **Step 2: MatchingEngine에 pause 체크 추가**

`src/core/matching/MatchingEngine.ts`의 `submitOrder` 메서드 첫 줄에:
```typescript
if ((this as any)._paused) {
  this.emit('rejected', order.id, 'Server paused')
  return
}
```

- [ ] **Step 3: tsc 체크 후 커밋**

```bash
npx tsc --noEmit
git add src/admin/routes.ts src/core/matching/MatchingEngine.ts
git commit -m "feat: admin API routes — stats, blocklist, pause/resume"
```

---

## Task 16: Admin Dashboard (HTML)

**Files:**
- Create: `src/admin/public/index.html`
- Modify: `src/api/server.ts` — static 파일 서빙 + admin routes 등록

- [ ] **Step 1: @fastify/static 설치**

```bash
npm install @fastify/static
```

- [ ] **Step 2: Admin Dashboard HTML 작성**

`src/admin/public/index.html` — 다크 테마 대시보드:
```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HyperKRW Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0d1117; color: #e6edf3; min-height: 100vh; }
    header { background: #161b22; border-bottom: 1px solid #30363d;
             padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; font-weight: 600; color: #58a6ff; }
    .badge { background: #1f6feb; color: #fff; font-size: 11px;
             padding: 2px 8px; border-radius: 12px; }
    main { padding: 24px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; }
    .card h2 { font-size: 13px; color: #8b949e; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-val { font-size: 28px; font-weight: 700; color: #58a6ff; }
    .stat-label { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .section { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .section h2 { font-size: 15px; font-weight: 600; margin-bottom: 16px; color: #e6edf3; }
    .btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer;
           font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
    .btn:hover { opacity: 0.8; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-danger  { background: #da3633; color: #fff; }
    .btn-warn    { background: #9e6a03; color: #fff; }
    .btn-blue    { background: #1f6feb; color: #fff; }
    .input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3;
             padding: 8px 12px; border-radius: 6px; font-size: 13px; width: 100%; }
    .input:focus { outline: none; border-color: #58a6ff; }
    .row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
    .tag { background: #21262d; border: 1px solid #30363d; border-radius: 4px;
           padding: 4px 8px; font-size: 12px; font-family: monospace;
           display: flex; align-items: center; gap: 8px; }
    .tag-remove { cursor: pointer; color: #f85149; font-size: 16px; line-height: 1; }
    .tag-remove:hover { color: #ff7b72; }
    #blocklist-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; min-height: 32px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    .dot-green { background: #3fb950; }
    .dot-red   { background: #f85149; }
    .dot-yellow{ background: #d29922; }
    #status-msg { font-size: 12px; color: #8b949e; margin-top: 8px; height: 16px; }
    .pause-btns { display: flex; gap: 8px; }
    #api-key-input { background: #0d1117; border: 1px solid #30363d; color: #e6edf3;
                     padding: 8px 12px; border-radius: 6px; font-size: 13px; width: 320px; }
    .auth-bar { background: #161b22; border-bottom: 1px solid #30363d;
                padding: 12px 24px; display: flex; align-items: center; gap: 12px; font-size: 13px; }
    .auth-bar label { color: #8b949e; }
    #server-status { display: flex; align-items: center; font-size: 13px; }
  </style>
</head>
<body>

<div class="auth-bar">
  <label>API Key:</label>
  <input type="password" id="api-key-input" placeholder="Enter ADMIN_API_KEY..." />
  <button class="btn btn-blue" onclick="saveKey()">접속</button>
  <span id="server-status" style="margin-left:auto">
    <span class="status-dot dot-yellow" id="status-dot"></span>
    <span id="status-text">연결 대기 중</span>
  </span>
</div>

<header>
  <h1>🛡 HyperKRW Admin</h1>
  <span class="badge">OPERATOR</span>
</header>

<main>
  <!-- Stats -->
  <div class="grid" id="stats-grid">
    <div class="card"><h2>업타임</h2><div class="stat-val" id="stat-uptime">—</div><div class="stat-label">초</div></div>
    <div class="card"><h2>메모리</h2><div class="stat-val" id="stat-memory">—</div><div class="stat-label">MB (heap used)</div></div>
    <div class="card"><h2>정산 대기</h2><div class="stat-val" id="stat-queue">—</div><div class="stat-label">배치 큐 사이즈</div></div>
  </div>

  <!-- Pause / Resume -->
  <div class="section">
    <h2>매칭 엔진 제어</h2>
    <div class="pause-btns">
      <button class="btn btn-warn" onclick="pauseEngine()">⏸ 매칭 일시정지</button>
      <button class="btn btn-primary" onclick="resumeEngine()">▶ 매칭 재개</button>
    </div>
    <div id="status-msg"></div>
  </div>

  <!-- Blocklist -->
  <div class="section">
    <h2>차단 주소 관리</h2>
    <div class="row">
      <input class="input" id="blocklist-input" placeholder="0x..." />
      <button class="btn btn-danger" onclick="addBlock()">차단 추가</button>
    </div>
    <div id="blocklist-tags"></div>
  </div>
</main>

<script>
  let API_KEY = localStorage.getItem('admin_api_key') || ''
  if (API_KEY) document.getElementById('api-key-input').value = API_KEY

  function saveKey() {
    API_KEY = document.getElementById('api-key-input').value.trim()
    localStorage.setItem('admin_api_key', API_KEY)
    refreshAll()
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    })
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json()
  }

  async function refreshStats() {
    try {
      const data = await apiFetch('/admin/stats')
      document.getElementById('stat-uptime').textContent = Math.floor(data.uptime)
      document.getElementById('stat-memory').textContent = data.memoryMB
      document.getElementById('stat-queue').textContent = data.queueSize
      document.getElementById('status-dot').className = 'status-dot dot-green'
      document.getElementById('status-text').textContent = '연결됨'
    } catch {
      document.getElementById('status-dot').className = 'status-dot dot-red'
      document.getElementById('status-text').textContent = '연결 실패'
    }
  }

  async function refreshBlocklist() {
    try {
      const data = await apiFetch('/admin/blocklist')
      const container = document.getElementById('blocklist-tags')
      container.innerHTML = ''
      if (data.blocked.length === 0) {
        container.innerHTML = '<span style="color:#8b949e;font-size:12px">차단된 주소 없음</span>'
        return
      }
      data.blocked.forEach(addr => {
        const tag = document.createElement('div')
        tag.className = 'tag'
        tag.innerHTML = `<span>${addr}</span><span class="tag-remove" onclick="removeBlock('${addr}')">×</span>`
        container.appendChild(tag)
      })
    } catch {}
  }

  async function addBlock() {
    const addr = document.getElementById('blocklist-input').value.trim()
    if (!addr) return
    try {
      await apiFetch('/admin/blocklist', { method: 'POST', body: JSON.stringify({ address: addr }) })
      document.getElementById('blocklist-input').value = ''
      await refreshBlocklist()
    } catch (e) { alert('추가 실패: ' + e.message) }
  }

  async function removeBlock(addr) {
    try {
      await apiFetch('/admin/blocklist/' + encodeURIComponent(addr), { method: 'DELETE' })
      await refreshBlocklist()
    } catch {}
  }

  async function pauseEngine() {
    try {
      await apiFetch('/admin/pause', { method: 'POST' })
      setMsg('⏸ 매칭 엔진 일시정지됨', '#d29922')
    } catch (e) { setMsg('실패: ' + e.message, '#f85149') }
  }

  async function resumeEngine() {
    try {
      await apiFetch('/admin/resume', { method: 'POST' })
      setMsg('▶ 매칭 엔진 재개됨', '#3fb950')
    } catch (e) { setMsg('실패: ' + e.message, '#f85149') }
  }

  function setMsg(msg, color) {
    const el = document.getElementById('status-msg')
    el.textContent = msg
    el.style.color = color
    setTimeout(() => { el.textContent = '' }, 3000)
  }

  function refreshAll() { refreshStats(); refreshBlocklist() }

  if (API_KEY) refreshAll()
  setInterval(refreshStats, 5000)
</script>
</body>
</html>
```

- [ ] **Step 3: server.ts에 admin 등록**

`src/api/server.ts`에 추가:
```typescript
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { adminRoutes } from '../admin/routes.js'

// buildServer deps에 admin 관련 추가:
// worker: SettlementWorker, blocklist: BasicBlocklistPlugin

// fastify 등록 부분에 추가:
const __dirname = dirname(fileURLToPath(import.meta.url))
fastify.register(fastifyStatic, {
  root: join(__dirname, '../../src/admin/public'),
  prefix: '/admin/ui',
})
fastify.register(adminRoutes({ config, matching, worker, store, blocklist }))
```

- [ ] **Step 4: index.ts에 blocklist + worker 연결**

`src/index.ts`에서 `buildServer` 호출 시 `worker`와 `blocklist` 추가 전달.

- [ ] **Step 5: tsc 체크 후 커밋**

```bash
npx tsc --noEmit
git add src/admin/public/index.html src/api/server.ts src/index.ts
git commit -m "feat: admin dashboard — dark theme HTML with stats, blocklist, pause/resume"
```

---

## 버전 관리 정책

| 태그 | 의미 |
|------|------|
| `v0.1.0` | Task 1-6 완료 (타입, 검증, 컴플라이언스, 오더북) |
| `v0.2.0` | Task 7-9 완료 (매칭, 정산, 체인워처) |
| `v0.3.0` | Task 10-13 완료 (API, WebSocket, 통합테스트) |
| `v0.4.0` | Task 14-16 완료 (어드민 대시보드) |
| `v1.0.0` | 테스트넷 검증 완료 후 릴리스 |

각 마일스톤 완료 시:
```bash
git tag v0.x.0
git push origin main --tags
```

---

## 상용화 확장 경로

| 기능 | 파일 | 변경 |
|------|------|------|
| Redis 오더북 | `src/core/orderbook/RedisOrderBookStore.ts` | IOrderBookStore 구현체 교체 |
| KYC 플러그인 | `src/compliance/plugins/KYCPlugin.ts` | `engine.register(new KYCPlugin(...))` |
| ZKP 검증 | `src/verification/ZKVerifier.ts` | EIP712Verifier → ZKVerifier 교체 |
| PostgreSQL 체결 내역 | `src/core/settlement/TradeRepository.ts` | TradeStore 교체 |
| worker_threads 매칭 | `src/core/matching/MatchingWorker.ts` | MatchingEngine 내부만 변경 |
