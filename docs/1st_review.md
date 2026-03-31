# HyperKRW CLOB DEX — 1차 코드 리뷰 결과

**작성일:** 2026년 3월 31일
**리뷰 범위:** P0/P1 전체 기능 구현 (Task 1~19) 완료 후 종합 검토
**기준 문서:** `CLAUDE.md`, `docs/research.md`

---

## 1. 테스트 결과 요약

| 대상 | 결과 | 상세 |
|---|---|---|
| 서버 테스트 (Vitest) | ✅ **120/120 통과** | 22개 테스트 파일 |
| 컨트랙트 테스트 (Foundry) | ✅ **65/65 통과** | 7개 test suite |
| TypeScript 빌드 | ✅ **에러 없음** | `settleBatch.ts` 수정 완료 (커밋 `54ee082`) |

---

## 2. 기능별 구현 상태

### ✅ 완전 구현 (P0/P1)

| 기능 | 파일 | 비고 |
|---|---|---|
| Market Order / IOC | `src/core/orderbook/OrderBook.ts` | market order는 depth에서 제외됨 |
| FOK / Post-Only | `src/core/orderbook/OrderBook.ts` | Pre-flight 체크 + 안전망 |
| STP (Self-Trade Prevention) | `src/core/orderbook/OrderBook.ts` | EXPIRE_TAKER 모드 |
| Stop-Loss / Take-Profit | `src/core/conditional/ConditionalOrderEngine.ts` | 가격 이벤트 구독 방식 |
| Reduce-Only | `src/core/position/PositionTracker.ts` | 포지션 방향·크기 검증 |
| Cancel-All (DELETE /orders) | `src/api/routes/orders.ts` | pair 필터 지원 |
| Order Amendment (PUT /orders/:nonce) | `src/api/routes/orders.ts` | 서명 검증 + 정책 체크 + 롤백 |
| Batch Order API (POST /orders/batch) | `src/api/routes/ordersBatch.ts` | max 50, 207 Multi-Status |
| Client Order ID 중복 방지 | `src/api/routes/orders.ts` | 409 반환 |
| GTT Expiry Sweeper | `src/core/expiry/ExpiryWorker.ts` | 10초 주기, hard+soft 만료 |
| API Key / Subkey 인증 | `src/api/auth/traderAuth.ts` | read/trade role 분리 |
| OHLCV 캔들 API (GET /candles/:pair) | `src/api/routes/candles.ts` / `CandleStore.ts` | 6개 해상도 |
| Fee Tier (3단계 + maker rebate) | `src/core/fees/FeeEngine.ts` | 30일 rolling volume |
| WebSocket Heartbeat | `src/api/websocket/stream.ts` | 30s ping / 10s pong timeout |
| 컨트랙트 보안 패턴 | `src/OrderSettlement.sol`, `HybridPool.sol` | UUPS, CEI, ReentrancyGuard |

### ⚠️ 부분 구현 (개선 필요)

| 기능 | 현재 상태 | 부족한 부분 |
|---|---|---|
| **STP** | EXPIRE_TAKER만 구현 | EXPIRE_MAKER, EXPIRE_BOTH 모드 미구현 (Paradex 권장) |
| **Funding Rate** | 기본 공식 `(mark-index)/index` | Rate cap(±600%) 미구현, premium impact price 미구현 |
| **Mark Price Oracle** | 5분 TWAP | 3-component median(Orderly 방식) 미구현, Pyth/Chainlink 미연동 |
| **Liquidation Engine** | 전량 청산 동작 | 부분 청산(20% 단위), 보험펀드, ADL 미구현 |
| **Cross/Isolated Margin** | 타입 정의 완료, MarginAccount 클래스 완료 | 레버리지 강제 적용, 포트폴리오 마진 계산 미구현 |

---

## 3. 발견된 이슈 및 조치

### 🔴 수정 완료 (이번 리뷰에서 해결)

#### settleBatch.ts TypeScript 빌드 에러 (커밋 `54ee082`)
- **원인:** viem v2의 `writeContract()`가 `chain`과 `account` 파라미터를 명시적으로 요구
- **수정 내용:**
  ```typescript
  // 수정 전
  await walletClient.writeContract({ address: ..., abi: ..., ... })

  // 수정 후
  await walletClient.writeContract({
    chain: undefined,
    account: walletClient.account!,
    address: ..., abi: ..., ...
  })
  ```

---

## 4. 다음 작업 권장사항 (우선순위 순)

### 🟠 High Priority — Perp 모드 메인넷 활성화 전 필수

#### [1] Funding Rate 캡 추가
- **파일:** `src/core/funding/FundingRateEngine.ts`
- **내용:** 극단적 펀딩레이트 방지. research.md §6.8 기준 ±600% cap 적용
- **예상 공수:** ~1시간
- **구현 가이드:**
  ```typescript
  // applyFunding() 내부, rateScaled 계산 직후에 삽입
  const MAX_RATE_SCALED = 6n * RATE_SCALE  // 600% cap
  const cappedRate = rateScaled > MAX_RATE_SCALED ? MAX_RATE_SCALED
                   : rateScaled < -MAX_RATE_SCALED ? -MAX_RATE_SCALED
                   : rateScaled
  // 이후 rawPayment는 cappedRate 사용
  ```

#### [2] 부분 청산 (20% 단위)
- **파일:** `src/core/liquidation/LiquidationEngine.ts`
- **내용:** 현재 전량 청산 → 포지션의 20%씩 단계적 청산 (Paradex 방식)
- **예상 공수:** ~6시간
- **구현 가이드:**
  - `submitLiquidationOrder()` 에서 `amount = pos.size * 20 / 100` 으로 변경
  - 청산 횟수 제한 및 상태 추적 추가
  - 청산 후 잔여 마진 재계산

#### [3] 보험펀드 (Insurance Fund)
- **파일:** `src/core/insurance/InsuranceFund.ts` (신규 생성)
- **내용:** 청산 수익 일부 적립 → 손실 발생 시 커버 → 소진 시 ADL 트리거
- **예상 공수:** ~8시간
- **구현 가이드:**
  - `deposit(pairId, amount)` / `cover(pairId, loss): boolean` 메서드
  - 보험펀드 소진 시 `EventEmitter`로 `'adl_needed'` 이벤트 발행

### 🟡 Medium Priority — P2 기능

#### [4] STP 모드 확장 (EXPIRE_MAKER, EXPIRE_BOTH)
- **파일:** `src/types/order.ts`, `src/core/orderbook/OrderBook.ts`
- **예상 공수:** ~4시간
- **구현 가이드:**
  ```typescript
  // order.ts에 추가
  export type StpMode = 'EXPIRE_TAKER' | 'EXPIRE_MAKER' | 'EXPIRE_BOTH'
  // Order 인터페이스에 추가
  stp?: StpMode
  ```
  OrderBook.runMatching()에서 stp 필드 분기 처리

#### [5] 3-component Mark Price (Orderly Network 방식)
- **파일:** `src/core/oracle/MarkPriceOracle.ts`
- **예상 공수:** ~8시간
- **구현 가이드:**
  ```
  P1 = indexPrice × (1 + lastFundingRate × timeToNextFunding)
  P2 = indexPrice + 15분MA(markPrice - indexPrice)
  midPrice = (bestBid + bestAsk) / 2
  markPrice = median(P1, P2, midPrice)
  ```
  - research.md §7.5 참고 (Orderly Network 방식)
  - MarkPriceOracle이 FundingRateEngine과 OrderBook에 접근 필요

#### [6] Margin 강제 적용
- **파일:** `src/margin/MarginAccount.ts`, `src/api/routes/orders.ts`
- **예상 공수:** ~8시간
- **구현 가이드:**
  - `canOpen(maker, mode, requiredMargin, leverage)` 레버리지 배율 파라미터 추가
  - Cross 모드: `effectiveMargin = totalBalance - unrealizedLoss`
  - Isolated 모드: `effectiveMargin = positionMargin만`
  - POST /orders에서 마진 체크 추가

### 🟢 Nice-to-Have — 미래 계획

#### [7] 외부 오라클 연동 (Pyth / Chainlink on HyperEVM)
- `MarkPriceOracle.setIndexPrice()`를 자동화
- Pyth SDK 또는 Chainlink price feed 구독
- research.md §7.1~7.3 참고

#### [8] TWAP 주문 / Scale 주문 (Iceberg)
- research.md §3.2, §3.6 참고
- 단계별 실행 + 랜덤화로 시장 충격 최소화

#### [9] Dead Man's Switch
- 설정된 시간 내 heartbeat 없으면 자동으로 모든 주문 취소
- 알고 트레이더 필수 기능

#### [10] ed25519 트레이더 키 인증
- 현재: ECDSA (EIP-712) + API Key 헤더
- 권장: ed25519 서명 기반 (Hyperliquid, dYdX v4 방식)
- research.md §10 참고

---

## 5. 아키텍처 현황 (CLAUDE.md 기준)

### 컨트랙트 (krw-dex-contracts)
```
src/
├── interfaces/IComplianceModule.sol   ✅ 준수
├── PairRegistry.sol                   ✅ 준수
├── OracleAdmin.sol                    ✅ 준수 (timelock + delta guard)
├── BasicCompliance.sol                ✅ 준수
├── FeeCollector.sol                   ✅ 준수
├── OrderSettlement.sol                ✅ 준수 (EIP-712, bitmap nonces)
└── HybridPool.sol                     ✅ 준수 (StableSwap + oracle fallback)
```

### 서버 (krw-dex-server)
```
src/
├── types/order.ts                     ✅ 전체 확장 완료
├── core/
│   ├── orderbook/OrderBook.ts         ✅ Market/IOC/FOK/Post-Only/STP
│   ├── matching/MatchingEngine.ts     ✅ FeeEngine 주입, price 이벤트 발행
│   ├── conditional/                   ✅ Stop-Loss/Take-Profit
│   ├── position/PositionTracker.ts    ✅ Reduce-Only 검증
│   ├── expiry/ExpiryWorker.ts         ✅ GTT 만료 스위퍼
│   ├── fees/FeeEngine.ts              ✅ 30d rolling, 3 tiers
│   ├── funding/FundingRateEngine.ts   ⚠️ cap 미구현
│   ├── oracle/MarkPriceOracle.ts      ⚠️ 단순 TWAP만
│   ├── liquidation/LiquidationEngine.ts ⚠️ 전량 청산만
│   └── candles/CandleStore.ts         ✅ 6개 해상도
├── margin/MarginAccount.ts            ⚠️ 로직 미완성
└── api/
    ├── routes/orders.ts               ✅ 전체 CRUD + 배치 + 인증
    ├── routes/candles.ts              ✅
    ├── routes/funding.ts              ✅
    ├── auth/traderAuth.ts             ✅ read/trade role
    └── websocket/stream.ts            ✅ heartbeat 포함
```

---

## 6. CLAUDE.md 준수 체크리스트

| 항목 | 상태 |
|---|---|
| UUPS proxy (`_disableInitializers()` in constructor) | ✅ |
| `__UUPSUpgradeable_init()` 미호출 (OZ v5 stateless) | ✅ |
| CEI 패턴 (checks-effects-interactions) | ✅ |
| SafeERC20 사용 | ✅ |
| ReentrancyGuard 적용 | ✅ |
| GUARDIAN role: pause-only (unpause 불가) | ✅ |
| EIP-712 bitmap nonce (signature replay 방지) | ✅ |
| MINIMUM_LIQUIDITY 영구 잠금 | ✅ |
| NatSpec 주석 (복잡한 함수) | ⚠️ 컨트랙트는 OK, 서버 비즈니스 로직 부족 |
| Foundry 테스트 내 role 상수 캐시 (staticcall 방지) | ✅ |

---

## 7. 주요 커밋 히스토리 (이번 세션)

```
54ee082 fix: settleBatch — add chain/account params for viem writeContract
896904b fix: SIGTERM — stop watcher before worker to prevent dropped events
ef8230e feat: wire all P0/P1 components into server and index (Task 19)
22f563d fix: Perp — bigint-safe margin and funding math
eab40f0 feat: Perp infra — FundingRateEngine, MarkPriceOracle, LiquidationEngine, MarginAccount
87a5fdb fix: WebSocket heartbeat — clear stacked pong timer
701741a feat: WebSocket heartbeat — 30s ping, 10s pong timeout
7c7dc81 fix: FeeEngine — 10n**18n literal, simplified rebate math
2b0f70a feat: volume-based fee tier engine (30d rolling, 3 tiers)
4413d0d feat: OHLCV candle store and GET /candles/:pair endpoint
944583f fix: traderAuth — FastifyRequest augmentation + DELETE tests
893f4ea feat: trader API key / subkey auth with read/trade roles
a819264 feat: clientOrderId dedup + GTT expiry sweeper
dbfe316 feat: POST /orders/batch — batch order submission
5ac8e7d feat: PUT /orders/:nonce — order amendment
```

---

## 8. 다음 작업 시작 전 참고사항

1. **현재 서버 브랜치:** `master` (krw-dex-server)
2. **현재 컨트랙트 브랜치:** `main` (krw-dex-contracts)
3. **Perp 기능은 현재 비활성화 상태** — `index.ts`에서 FundingRateEngine/LiquidationEngine을 초기화하지 않으면 작동 안 함. Perp 모드 활성화 전 §4 High Priority 항목 완료 필요.
4. **pre-existing 에러는 없음** — `tsc --noEmit` 클린 통과
5. **다음 작업 추천 순서:** Funding Rate Cap → 부분 청산 → 보험펀드 → STP 확장 → Mark Price 3-component
