# HyperKRW CLOB Server — Design Spec

**Date:** 2026-03-31
**Project:** krw-dex-server (별도 레포)
**Status:** Approved — ready for implementation planning

---

## Goal

HyperKRW DEX의 오프체인 CLOB(Central Limit Order Book) 매칭 서버를 구현한다. 클라이언트로부터 EIP-712 서명 주문을 수신하고, 인메모리 오더북에서 매칭 후, `OrderSettlement.settleBatch()`를 통해 HyperEVM에 온체인 정산한다. MVP부터 상용화까지 단계적으로 확장 가능한 구조로 설계한다.

---

## Tech Stack

- **Runtime:** Node.js 20 LTS + TypeScript 5
- **API Framework:** Fastify 4 (REST + WebSocket)
- **Chain 연동:** viem (EIP-712 서명 검증, 컨트랙트 호출)
- **테스트:** Vitest
- **빌드:** esbuild / tsx

---

## 아키텍처 원칙

### 계층 분리

```
클라이언트
    ↕ REST / WebSocket
API Gateway (Fastify)
    ↕ 인터페이스
Core Engine (OrderBook · Matching · Settlement · ChainWatcher)
    ↕ 인터페이스
Compliance Layer (PolicyEngine)
    ↕ 인터페이스
Verification Layer (IOrderVerifier)
    ↕ viem
HyperEVM (OrderSettlement · PairRegistry · OracleAdmin)
```

각 레이어는 인터페이스를 통해 통신한다. 구현체 교체(Memory→Redis, EIP712→ZKP, BasicCompliance→KYC) 시 상위 레이어는 변경 없다.

---

## 핵심 설계 결정 4가지

---

### 1. TPS 성능 설계

**목표:** 오프체인 매칭 5,000+ TPS, 온체인 정산 ~20 TPS (HyperEVM 1s 블록 × 배치 20건)

**병목 분석:**

| 레이어 | TPS | 비고 |
|--------|-----|------|
| 오프체인 매칭 (인메모리) | ~5,000 | 실제 병목 아님 |
| 온체인 정산 (settleBatch) | ~20 | HyperEVM 블록타임 한계 |
| Redis 오더북 (상용) | ~50,000+ | 수평확장 시 |

**구현 방법:**

**A. API / 매칭 분리 — worker_threads**

`MatchingEngine`을 Node.js `worker_threads`로 실행한다. API 이벤트루프(I/O)와 매칭 연산(CPU)을 분리해 매칭 부하가 API 응답 지연으로 전이되지 않는다.

```
메인 스레드:   API Gateway → 주문 큐 → Worker 메시지
매칭 워커:    Queue 소비 → 매칭 → 배치 큐 적재
정산 워커:    배치 큐 → settleBatch() → 결과 이벤트
```

**B. IOrderBookStore 인터페이스**

```typescript
interface IOrderBookStore {
  addOrder(order: StoredOrder): Promise<void>
  removeOrder(orderId: string): Promise<void>
  getBestBid(pairId: string): Promise<StoredOrder | null>
  getBestAsk(pairId: string): Promise<StoredOrder | null>
  getDepth(pairId: string, levels: number): Promise<OrderBookDepth>
}
```

- **MVP:** `MemoryOrderBookStore` — Map 기반, 싱글 인스턴스
- **상용:** `RedisOrderBookStore` — Redis Sorted Set, 다중 인스턴스 지원

교체 시 비즈니스 로직 무변경.

**C. 배치 정산 트리거**

```typescript
// 1초 타이머 OR 10건 배치 — 먼저 충족되는 조건
const BATCH_TIMEOUT_MS = 1000
const BATCH_SIZE = 10
```

---

### 2. 컴플라이언스 — Policy Engine (플러그인 구조)

온체인 `IComplianceModule`과 1:1 대응하는 오프체인 정책 엔진. 오프체인에서 사전 차단해 불필요한 가스 낭비를 방지한다.

**IPolicyPlugin 인터페이스**

```typescript
interface TradeContext {
  maker: Address
  taker: Address
  baseToken: Address
  quoteToken: Address
  amount: bigint
  price: bigint
}

interface PolicyResult {
  allowed: boolean
  reason?: string
}

interface IPolicyPlugin {
  name: string
  check(ctx: TradeContext): Promise<PolicyResult>
}
```

**PolicyEngine**

```typescript
class PolicyEngine {
  register(plugin: IPolicyPlugin): void
  // 직렬 실행 — 첫 번째 거부에서 즉시 중단
  async check(ctx: TradeContext): Promise<PolicyResult>
}
```

**MVP 플러그인**

| 플러그인 | 기능 | 데이터 소스 |
|----------|------|-------------|
| `BasicBlocklistPlugin` | 차단 주소 확인 | BasicCompliance 컨트랙트 이벤트 |
| `GeoBlockPlugin` | IP 기반 국가 차단 | 요청 IP → GeoIP 라이브러리 |

**상용화 플러그인 (추가만 하면 됨)**

| 플러그인 | 기능 |
|----------|------|
| `KYCPlugin` | Jumio / Persona API 연동 |
| `AMLPlugin` | Chainalysis API 연동 |
| `TravelRulePlugin` | FATF Travel Rule (VASP 간 정보 공유) |
| `SanctionsPlugin` | OFAC SDN 리스트 검사 |
| `VolumeCapPlugin` | 일일 거래 한도 |

새 규제 요건 = 플러그인 파일 하나 추가. 기존 코드 무변경.

---

### 3. 프라이버시 — IOrderVerifier 추상화

ZKP 또는 FHE 도입 시 서버 코드 최소 변경으로 전환 가능하도록 검증 레이어를 추상화한다.

**Order 타입**

```typescript
interface Order {
  maker: Address
  taker: Address          // address(0) = any
  baseToken: Address
  quoteToken: Address
  price: bigint           // quoteToken per baseToken (18 decimals)
  amount: bigint
  isBuy: boolean
  nonce: bigint
  expiry: bigint
  proof?: Hex             // 미래: ZK proof (현재 미사용)
}
```

**IOrderVerifier 인터페이스**

```typescript
interface IOrderVerifier {
  verify(order: Order, sig: Hex): Promise<boolean>
}
```

**구현체**

| 구현체 | 시기 | 설명 |
|--------|------|------|
| `EIP712Verifier` | 현재 (MVP) | viem `verifyTypedData`, 도메인 분리자 캐시 |
| `ZKVerifier` | 중기 | snarkjs + circom — 주문 내용 비공개, 유효성 증명만 |
| `FHEVerifier` | 장기 | 암호화된 주문으로 매칭 — 완전 다크풀 |

**ZKP 전환 시나리오 (미래)**

1. `ZKVerifier` 구현체 작성
2. `config.verifier = new ZKVerifier()` 한 줄 교체
3. 온체인: `OrderSettlement`에 ZK Verifier 컨트랙트 연동 (별도 업그레이드)
4. Order 타입의 `proof` 필드 활성화

오프체인 서버 변경 범위: verifier 교체 1개 파일.

---

### 4. UI/UX — 별도 프론트엔드 프로젝트

서버는 UI-agnostic API를 제공한다. 프론트엔드는 `krw-dex-frontend` 별도 레포로 구현한다.

**서버가 제공하는 API (프론트 요구사항 기준 설계)**

```
WebSocket /stream
  → orderbook.snapshot   : 현재 오더북 전체 (접속 시)
  → orderbook.update     : 변경분 (delta) 스트림
  → trades.recent        : 실시간 체결 스트림
  → order.status         : 내 주문 상태 변경

REST
  POST   /orders           : 주문 제출 (EIP-712 서명 포함)
  DELETE /orders/:nonce    : 주문 취소
  GET    /orderbook/:pair  : 오더북 스냅샷
  GET    /trades/:pair     : 최근 체결 내역
  GET    /orders/:address  : 내 미체결 주문
```

**프론트엔드 스택 (별도 레포)**

- Next.js 14 (App Router)
- wagmi v2 + viem (지갑 연결, EIP-712 서명)
- TradingView Lightweight Charts (캔들, 오더북 뎁스 차트)
- 한국어 우선, 모바일 퍼스트

**UX 차별화 포인트**

- 원클릭 주문: 지갑 서명 한 번으로 주문 제출
- 실시간 체결: WebSocket으로 지연 없는 오더북 업데이트
- 직관적 KRW 단위 표시 (예: 1,350원/USDC)

---

## 프로젝트 구조

```
krw-dex-server/
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── orders.ts          # POST /orders, DELETE /orders/:nonce
│   │   │   ├── orderbook.ts       # GET /orderbook/:pair
│   │   │   └── trades.ts          # GET /trades/:pair
│   │   ├── websocket/
│   │   │   └── stream.ts          # WebSocket /stream
│   │   └── server.ts              # Fastify 앱 생성
│   ├── core/
│   │   ├── orderbook/
│   │   │   ├── IOrderBookStore.ts # 인터페이스
│   │   │   ├── MemoryOrderBookStore.ts
│   │   │   └── OrderBook.ts       # Price-time 우선순위 로직
│   │   ├── matching/
│   │   │   └── MatchingEngine.ts  # worker_threads 기반
│   │   ├── settlement/
│   │   │   └── SettlementWorker.ts # 배치 정산 (1s / 10건)
│   │   └── watcher/
│   │       └── ChainWatcher.ts    # OrderFilled / Cancelled 이벤트 동기화
│   ├── compliance/
│   │   ├── IPolicyPlugin.ts       # 인터페이스
│   │   ├── PolicyEngine.ts        # 플러그인 레지스트리
│   │   └── plugins/
│   │       ├── BasicBlocklistPlugin.ts
│   │       └── GeoBlockPlugin.ts
│   ├── verification/
│   │   ├── IOrderVerifier.ts      # 인터페이스
│   │   ├── EIP712Verifier.ts      # 현재 구현체
│   │   └── ZKVerifier.ts          # 미래 stub
│   ├── chain/
│   │   ├── contracts.ts           # viem 컨트랙트 인스턴스
│   │   └── wallet.ts              # operator 지갑
│   ├── types/
│   │   └── order.ts               # Order, StoredOrder 타입
│   └── config/
│       └── config.ts              # 환경변수 로드
├── test/
│   ├── unit/
│   └── integration/
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 상용화 확장 경로

| 단계 | 변경 사항 |
|------|-----------|
| **MVP** | MemoryOrderBookStore, EIP712Verifier, BasicBlocklist |
| **베타** | RedisOrderBookStore, PostgreSQL 체결 내역, KYCPlugin 추가 |
| **상용** | 수평 확장 (K8s), AML/TravelRule 플러그인, ZKVerifier, API 키 인증 |

인터페이스 기반 설계로 각 단계 전환 시 교체 범위가 구현체 1개 파일로 제한된다.

---

## 온체인 연동 요약

| 함수 | 용도 | 호출자 |
|------|------|--------|
| `OrderSettlement.settleBatch()` | 배치 정산 | SettlementWorker (OPERATOR_ROLE) |
| `PairRegistry.isTradeAllowed()` | 거래쌍 활성 확인 | MatchingEngine 사전 검사 |
| `OracleAdmin.getPrice()` | KRW 환율 조회 | API (시세 표시용) |
| `OrderSettlement` 이벤트 | OrderFilled / Cancelled | ChainWatcher |

**EIP-712 도메인**
- Name: `"KRW DEX"` / Version: `"1"` / ChainId: HyperEVM 런타임 감지
- OrderTypeHash: `Order(address maker,address taker,address baseToken,address quoteToken,uint256 price,uint256 amount,bool isBuy,uint256 nonce,uint256 expiry)`

---

## 보안 고려사항

- Operator 개인키는 환경변수로만 관리, 코드에 하드코딩 금지
- 주문 제출 엔드포인트에 Rate limiting (Fastify rate-limit 플러그인)
- EIP-712 서명 검증 실패 시 즉시 거부 (온체인 가스 낭비 방지)
- PolicyEngine 실패 시 주문 거부 (fail-closed 원칙)
- ChainWatcher 재연결 로직 (지수 백오프)
