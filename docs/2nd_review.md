# HyperKRW DEX — 2차 종합 코드 리뷰 (2nd Comprehensive Code Review)

**Date:** 2026-04-02
**Reviewer:** Senior Code Review (Claude Sonnet 4.6)
**Scope:** krw-dex-contracts + krw-dex-server (full codebase)
**Test Results (claimed):** 198/198 server tests, 132/132 contract tests

---

## 목차 (Table of Contents)

1. Executive Summary & Grades
2. 아키텍처 품질 (Architecture Quality)
3. 컨트랙트 상세 리뷰 (Contract-by-Contract Review)
4. 서버 상세 리뷰 (Server Component Review)
5. 보안 고려사항 (Security Considerations)
6. 테스트 커버리지 품질 (Test Coverage Quality)
7. 잘 된 점 (Strengths)
8. 개선이 필요한 점 (Issues & Risks)
9. 오픈소스 정렬도 (Open-Source Alignment)
10. 테스트넷 배포 리스크 평가 (Testnet Risk Assessment)
11. 다음 단계 권장사항 — 프론트엔드 (Next Phase Recommendations)

---

## 1. Executive Summary & Grades

| 영역 | 등급 | 비고 |
|------|------|------|
| 계약 아키텍처 | **A-** | UUPS + CEI + SafeERC20 일관 적용. 미세한 구조적 취약점 존재 |
| 계약 코드 품질 | **B+** | InsuranceFund.deposit CEI 역전 문제, ADL 수집 후 미분배 |
| 서버 아키텍처 | **A-** | EventEmitter 기반 반응형 파이프라인. 단일 프로세스 한계 명확 |
| 서버 코드 품질 | **B+** | PositionTracker.getAll()의 margin=0n 문제가 핵심 리스크 |
| 보안 | **B+** | 재진입 방어 우수. 오라클 신뢰 모델 및 ADL 자금 유출 주의 |
| 테스트 커버리지 | **A-** | 행복 경로 및 엣지 케이스 모두 포함. 퍼즈 테스트 부족 |
| 오픈소스 정렬 | **B+** | dYdX/Hyperliquid 패턴 충실히 참조. 주요 차이점 문서화됨 |

**전체 평가: B+ (테스트넷 배포 준비 완료, 메인넷 전 추가 감사 필요)**

---

## 2. 아키텍처 품질 (Architecture Quality)

### 2.1 전체 설계 철학

HyperKRW는 **오프체인 CLOB 매칭 + 온체인 EIP-712 결제** 구조를 채택했으며, 이는 dYdX v4 및 Orderly Network의 검증된 패턴과 일치한다. 핵심 설계 결정들:

- **UUPS 프록시 패턴:** 모든 9개 컨트랙트에 일관 적용. OZ v5의 `__UUPSUpgradeable_init()` 미존재 처리 올바름.
- **역할 분리:** `DEFAULT_ADMIN_ROLE / OPERATOR_ROLE / GUARDIAN_ROLE` 3계층. GUARDIAN의 pause-only 비대칭 설계가 적절함.
- **이벤트 기반 서버:** `EventEmitter` 체인(`matched → positionTracker.onMatch → markOracle.onTrade → conditionalEngine.onPrice`)이 단방향 데이터 흐름을 유지한다.

### 2.2 아키텍처 강점

- `IComplianceModule` 인터페이스를 통한 compliance 모듈 교체 가능 설계.
- `IInsuranceFund` 좁은 인터페이스(DI)로 `LiquidationEngine`이 구체 `EventEmitter` 클래스에 의존하지 않음.
- `InsuranceFundSyncer`가 온체인 `LiquidationFeeRouted` 이벤트를 구독하여 오프체인 보험기금과 동기화. 올바른 단방향 진실 소스 패턴.
- `Deploy.s.sol` → `Config.s.sol` 2단계 배포 분리. 역할 부여를 별도 트랜잭션으로 처리.

### 2.3 아키텍처 우려사항

**중요 (Important):**

1. **단일 프로세스 비내구성:** 서버 전체 상태(`MemoryOrderBookStore`, `PositionTracker`, `InsuranceFund`, `FundingRateEngine` 타이머)가 메모리에만 존재한다. 프로세스 재시작 시 오더북과 포지션이 소실된다. 테스트넷에서는 허용 가능하나, 메인넷 전 Redis/PostgreSQL 기반 지속성 레이어가 필수적이다.

2. **온체인-오프체인 포지션 불일치 위험:** `PositionTracker`는 `MatchResult`를 구독하여 포지션을 추적하지만, `MarginRegistry` 온체인 컨트랙트와 동기화되지 않는다. `SettlementWorker` 실패 시 오프체인과 온체인 포지션이 분기된다. 이 분기가 잘못된 청산을 유발할 수 있다.

3. **청산 간격 30초 고정:** `index.ts`의 `setInterval(30_000)` 청산 검사는 테스트넷에 적절하나, 변동성 급등 시 과도한 스킵이 발생할 수 있다. 설정 가능한 파라미터로 외부화를 권장한다.

---

## 3. 컨트랙트 상세 리뷰 (Contract-by-Contract Review)

### 3.1 OrderSettlement.sol — 등급: B+

**잘 된 점:**
- CEI 패턴이 `_settle()` 및 `_settleSinglePair()`에서 명확하게 분리됨: Checks → Effects (`filledAmount` 업데이트) → Interactions (`_executeTransfers`).
- 비트맵 논스 (`nonceBitmap[user][wordIndex]`)는 비순차적 취소를 허용하며 Seaport 패턴과 일치.
- `_externalSettleFunding()` / `_externalSettle()` `try/catch` 래퍼 패턴이 배치 내 부분 실패를 올바르게 처리함.
- `isLiquidation` 플래그로 fee 라우팅을 `InsuranceFund` 또는 `FeeCollector`로 조건부 분기하는 구현이 명확함.

**발견된 문제:**

**[중요] takerSig 미검증 경로:**
`_settle()` 및 `_settleSinglePair()` 모두 `takerSig.length > 0`일 때만 서명을 검증한다. 즉, 오퍼레이터는 빈 서명(`""`)으로 taker 서명 없이 settle을 호출할 수 있다. 오퍼레이터가 완전히 신뢰되는 설계라면 의도적인 패턴이지만, NatSpec에 이 보안 가정을 명시해야 한다.

```solidity
// 현재 코드 (OrderSettlement.sol:402-405)
if (takerSig.length > 0) {
    _verifySignature(takerOrder.maker, takerHash, takerSig);
}
// 위험: takerSig=""이면 taker 서명 없이 결제됨
```

**[중요] settleADL의 자금 미분배 문제:**
`settleADL()`이 수집한 `quoteToken`이 `address(this)` (OrderSettlement)에 남는다. 이 자금을 InsuranceFund로 이동하거나 손실 측에 분배하는 로직이 없다. 수집된 자금이 영구적으로 컨트랙트에 잠길 수 있다.

```solidity
// OrderSettlement.sol:287-307 — collected 이후 분배 없음
uint256 collected = 0;
for (uint256 i = 0; i < entries.length; i++) {
    // ... transferFrom to address(this) ...
    collected += entry.amount;
    // ... emit ADLExecuted
}
require(collected > 0, "ADL: no funds collected");
// collected는 address(this)에 남고 아무도 꺼내지 않음
```

**[제안] settleLiquidation의 fillAmt 계산:**
현재 `min(makerOrder.amount, takerOrder.amount)`로 계산한다. 실제로는 이미 체결된 양(`filledAmount[makerHash]`)을 뺀 잔여량으로 계산해야 한다. 배치 청산 시나리오에서 오버필 리버트가 발생할 수 있다.

**[제안] _verifySignature 에러 메시지:**
taker 서명 검증 실패 시에도 "Invalid maker signature"라고 표시된다. 디버깅을 위해 "Invalid taker signature"로 구분해야 한다.

### 3.2 InsuranceFund.sol — 등급: A-

**잘 된 점:**
- `cover()` 부분 커버리지 지원 및 `InsuranceFundExhausted` 이벤트 발행.
- `withdraw()`가 `whenNotPaused` 없이 admin 비상 인출 허용 (의도적 설계, 주석으로 문서화됨).
- `deposit()` 내 OPERATOR_ROLE 제한으로 무단 입금 방지.

**발견된 문제:**

**[중요] deposit()의 CEI 역전:**
```solidity
// InsuranceFund.sol:69-72 — Interactions(transfer) before Effects(balance update)
IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
balances[pairId][token] += amount;  // <-- Effect가 Interaction 이후
```
`nonReentrant` 가드가 있어 현재 악용 가능성은 낮지만, 컨트랙트 자체의 CEI 주석("CEI: transfer first, then update state")이 CEI를 잘못 정의하고 있다. CEI는 Effects(상태 변경) → Interactions(외부 호출) 순서이다. 주석을 수정하고 순서를 올바르게 하거나 기존 순서가 의도적임을 명시해야 한다.

### 3.3 MarginRegistry.sol — 등급: A-

**잘 된 점:**
- `isUnderMargin()`의 `pos.size > 0 ? uint256(pos.size) : uint256(-pos.size)` 패턴이 `int256.min` 언더플로를 올바르게 처리 (C-3 요구사항 충족).
- `updatePosition()`에서 `require(size != type(int256).min)` 가드.
- `addMargin()`의 CEI 패턴이 올바름: 잔액 업데이트 후 `safeTransferFrom`.

**발견된 문제:**

**[제안] addMargin() — isolated 모드 전용 검사 부재:**
`addMargin()`이 포지션 모드에 관계없이 마진을 추가한다. cross 모드 포지션에 마진을 추가하면 상태가 불일치할 수 있다. 최소한 주석이나 `require(pos.mode == MarginMode.ISOLATED)` 가드를 추가해야 한다.

**[제안] withdrawMargin() — 잔액 추적 없음:**
`withdrawMargin()`이 `positions` 매핑의 실제 마진 잔액을 확인하지 않고 raw ERC20 잔액에서 직접 인출한다. 긴급 인출 시 회계 불일치가 발생할 수 있다.

### 3.4 HybridPool.sol — 등급: B+

**잘 된 점:**
- Curve StableSwap 2-pool 수학 (`_getD`, `_getY`) 구현이 원본 참조 구현과 일치.
- `lastLiquidityChangeBlock` 플래시 론 방어.
- `lock / notLocked` 이중 재진입 방어 (write-write + read-only).
- `rampA()` 7일 최소 기간 및 10배 최대 변경 제한.

**발견된 문제:**

**[중요] 소수점 정규화 없음 (decimal normalization):**
USDC는 6 decimal, USDT는 6 decimal이지만 KRW 스테이블코인은 18 decimal로 가정한다. `poolBalances[]` 배열은 두 토큰의 raw 잔액을 그대로 저장하므로, 6 decimal 토큰 추가 시 StableSwap 수학이 크게 왜곡된다. Curve 원본은 `rates[]` 배열로 정규화를 수행한다.

```solidity
// HybridPool.sol:463-469 — xp 배열에 정규화 없음
uint256[2] memory xp = [poolBalances[0], poolBalances[1]];
// KRW(18 decimal) vs USDC(6 decimal) → 1e12 배율 차이로 수학 결과가 틀림
```

**[중요] addLiquidity()의 비례 입금 강제화:**
`addLiquidity()`가 비율 기반 LP 민팅을 사용하므로 불균형 입금이 유동성 공급자에게 불리하다. Curve는 D 불변량 기반 계산으로 불균형 입금을 지원한다. 현재 구현은 단순화되었으며, 초기 유동성 공급 이후 재투자 시 항상 정확한 비율로 공급해야 한다는 제약이 있다.

**[제안] HybridPool.pause():**
HybridPool의 `pause()`는 `DEFAULT_ADMIN_ROLE`이 호출한다. 다른 컨트랙트의 비대칭 패턴(GUARDIAN이 pause, ADMIN이 unpause)과 불일치한다.

### 3.5 OracleAdmin.sol — 등급: A

**잘 된 점:**
- 2시간 타임록 + 델타 가드의 조합이 KRW 레이트 조작을 효과적으로 제한.
- `applyRate()`에서 현재 가격 기준 재검증(`_checkDelta`)으로 타임록 기간 중 가격 급변 대응.
- `postMarkPrice()`의 ±20% 새니티 체크.
- `setRateImmediate()` 비상 우회 경로가 DEFAULT_ADMIN_ROLE로 제한됨.

**발견된 문제:**

**[제안] postMarkPrice() — 타임스탬프 스탈니스 검사 부재:**
`postMarkPrice()`가 게시된 마크 가격의 유효기간을 체크하지 않는다. `getMarkPrice()`도 타임스탬프를 반환하지만 스탈 체크 로직이 없다. 오라클이 장시간 업데이트되지 않으면 청산 엔진이 오래된 가격을 사용할 수 있다. `getPrice()`의 `maxStaleness` 패턴을 `postMarkPrice()`에도 적용할 것을 권장한다.

### 3.6 PairRegistry.sol — 등급: A

**잘 된 점:**
- `isTradeAllowed()`가 pair 활성 상태, 토큰 화이트리스트, fee-on-transfer, rebase 플래그를 모두 확인.
- `getAllPairIds()` 뷰 함수로 서버 시작 시 페어 등록 가능.

**발견된 문제:**

**[제안] pairIds 배열 무제한 증가:**
`getAllPairIds()`가 `pairIds[]` 전체를 반환한다. 비활성 페어를 삭제하는 메커니즘이 없어 장기적으로 가스 비용이 증가할 수 있다. 비활성 페어 제거 기능 또는 페이지네이션을 고려해야 한다.

### 3.7 BasicCompliance.sol — 등급: A-

**잘 된 점:**
- `blockAddress()` (OPERATOR_ROLE) vs `unblockAddress()` (ADMIN_ROLE) 비대칭이 의도적이며 문서화됨.
- `IComplianceModule` 인터페이스 구현으로 교체 가능성 확보.

**발견된 문제:**

**[중요] OPERATOR_ROLE 미부여 (Config.s.sol):**
`BasicCompliance`에 `OPERATOR_ROLE`을 부여하는 설정이 `Config.s.sol`에 포함되어 있지만, `blockAddress()`를 호출하는 오퍼레이터 서버가 실제로 이 역할을 가지는지 확인이 필요하다. `Config.s.sol`이 이를 처리하지만 컨트랙트 레벨에서도 검증 로직이 있어야 한다.

### 3.8 FeeCollector.sol — 등급: A

**잘 된 점:**
- `depositFee()` Effect-before-Interaction 패턴 올바름.
- `DEPOSITOR_ROLE` 별도 구분으로 불필요한 권한 부여 최소화.

**발견된 문제:**

**[제안] 토큰별 인출자 제한 없음:**
어떤 admin이든 어떤 토큰이든 인출할 수 있다. 멀티시그 기반 admin이 설정된다면 문제는 완화되지만, 특정 토큰-인출자 매핑 등의 세분화된 제어를 고려할 수 있다.

### 3.9 Deploy.s.sol / Config.s.sol — 등급: A-

**잘 된 점:**
- `Deploy.s.sol`이 `InsuranceFund.initialize(admin, address(settlement), guardian)`으로 settlement를 OPERATOR로 자동 설정.
- `Config.s.sol` 마지막에 "Transfer admin role to Gnosis Safe multisig" 안내 출력.
- `usdc == address(0)` 조건부 처리로 USDT-only 또는 USDC-only 배포 지원.

**발견된 문제:**

**[중요] MockERC20 import가 배포 스크립트에 포함:**
`Deploy.s.sol`이 `../test/mocks/MockERC20.sol`을 import한다. 테스트 목 컨트랙트가 프로덕션 배포 스크립트에 포함되어 있다. 실수로 프로덕션에 MockERC20이 배포될 위험이 있다. 테스트넷 전용 분기 스크립트와 프로덕션 스크립트를 분리해야 한다.

**[중요] OPERATOR_ROLE을 OracleAdmin에 부여하지 않음:**
`Deploy.s.sol`은 OracleAdmin에 OPERATOR_ROLE을 부여하지 않는다. `Config.s.sol`에서 처리하지만 두 스크립트를 순서대로 실행해야 한다는 점이 문서화되어야 하며, `Config.s.sol` 실행 전 상태에서 오라클이 작동하지 않는 기간이 발생한다.

---

## 4. 서버 상세 리뷰 (Server Component Review)

### 4.1 index.ts — 등급: A-

**잘 된 점:**
- 컴포넌트 와이어링이 선형적이고 가독성이 높음.
- `positionTracker` → `matching`, `markOracle`, `insuranceFund`, `fundingEngine` 의존성 흐름이 명확.
- `SIGTERM` 핸들러가 모든 엔진을 순서대로 정지시킴 (graceful shutdown).
- 시작 시 `pairRegistry.read.getAllPairIds()`로 온체인 페어를 로드하고 실패 시 경고만 발행 (연결 오류가 시작을 막지 않음).

**발견된 문제:**

**[중요] liquidationInterval이 SIGTERM 외에서 정리되지 않음:**
`clearInterval(liquidationInterval)`이 `SIGTERM` 핸들러에만 있다. `SIGINT` (Ctrl+C) 또는 `uncaughtException`에서 종료 시 인터벌이 정리되지 않을 수 있다.

**[제안] insuranceSyncer 시작이 pairIdMap 구축보다 후행:**
`insuranceSyncer.start()`가 `pairIdMap` 구축 후에 호출되므로, 시작 전 블록에서 발생한 `LiquidationFeeRouted` 이벤트를 놓칠 수 있다. 블록체인 재조직(reorg) 또는 노드 재시작 시 보험기금 잔액이 부정확해질 수 있다. 시작 시 과거 이벤트를 한 번 조회하는 초기화 로직이 필요하다.

### 4.2 MatchingEngine.ts — 등급: A-

**잘 된 점:**
- `IPositionReader` 인터페이스로 `PositionTracker`에 대한 느슨한 결합.
- Reduce-Only 검증이 `submitOrder()` 진입 시 즉시 수행됨.
- `(this as any)._paused` 체크 패턴은 타입 안전성을 포기한 workaround임 (개선 필요).

**발견된 문제:**

**[중요] `(this as any)._paused` 패턴:**
`as any` 캐스트는 TypeScript 타입 안전성을 우회한다. `private _paused = false` 속성과 `pause()` / `resume()` 메서드를 정식으로 구현해야 한다.

### 4.3 OrderBook.ts — 등급: A

**잘 된 점:**
- Price-time priority 매칭이 `getBestAsk/getBestBid` 기반으로 올바르게 구현됨.
- STP 3-mode (EXPIRE_TAKER/EXPIRE_MAKER/EXPIRE_BOTH) 완전 구현.
- `EXPIRE_MAKER` 경로에서 `continue`로 루프를 계속하여 taker가 다음 메이커와 매칭 가능.
- POST_ONLY, FOK, IOC 시맨틱이 정확하게 구현됨.
- FOK TOCTOU 경쟁 조건에 대한 주석 문서화.

**발견된 문제:**

**[제안] 시장가 주문의 실행 가격:**
`execPrice = counter.price`로 설정되어 있다. 시장가 주문이 여러 가격 레벨에 걸쳐 체결될 때 개별 체결가가 `MatchResult.price`에 기록되지만, 평균 체결가 계산 로직이 없다. 프론트엔드 표시용 VWAP 계산이 필요하다.

### 4.4 LiquidationEngine.ts — 등급: B+

**잘 된 점:**
- `selectADLTargets()`의 effectiveLeverage 랭킹 알고리즘이 Hyperliquid/dYdX v4 패턴과 일치.
- 정수 정밀도 보존을 위해 `score = notional * SCALE / margin` 순서가 올바름.
- 단계별 자동 정리 (`liquidationSteps.delete(posKey)` at step 5).
- `submitLiquidationOrder()`의 tiny position fallback (0n 방지).

**발견된 문제:**

**[중요] insuranceFund.cover()에 token 파라미터 없음:**
오프체인 `InsuranceFund.cover(pairId, loss)`는 `pairId`만을 키로 사용한다. 온체인 `InsuranceFund.cover(pairId, token, loss)`는 `(pairId, token)` 복합 키를 사용한다. 온체인에 여러 quote 토큰(USDC/USDT)이 동일 pairId에 있을 경우 오프체인 잔액이 부정확해질 수 있다.

**[중요] PositionTracker.getAll()이 margin=0n을 반환:**
```typescript
// PositionTracker.ts:31-38
return [...this.pos.entries()].map(([key, size]) => {
  // ...
  return { maker, pairId, size, margin: 0n, mode: 'cross' as const }
  //                             ^^^^^^^^ 항상 0!
})
```
`LiquidationEngine.checkPositions()`에서 `pos.margin`을 사용하여 청산 여부를 판단하는데, `margin`이 항상 `0n`이면 모든 포지션이 즉시 청산 대상이 된다. `maintenance = notional * 2.5% > 0`이고 `margin = 0n < maintenance`이므로 항상 `true`. 이 문제가 실제 청산 폭풍을 유발할 수 있다.

이것이 현재 코드베이스에서 가장 심각한 버그이다. `PositionTracker`가 실제 마진을 추적하거나, `LiquidationEngine`이 `MarginAccount`에서 마진을 조회해야 한다.

**[제안] submitLiquidationOrder의 가격이 0n:**
```typescript
price: 0n,  // LiquidationEngine.ts:199
```
시장가 주문이 `price=0n`으로 제출된다. `OrderBook.runMatching()`에서 시장가 주문은 가격 체크를 건너뛰므로 실제로 작동하지만, 온체인 `OrderSettlement.settle()`에 전달될 때 `price=0`이면 `quoteAmount = 0`이 되어 토큰 이동이 전혀 없는 문제가 발생한다. 온체인 청산 결제 시 실제 mark price를 사용해야 한다.

### 4.5 FundingRateEngine.ts — 등급: A-

**잘 된 점:**
- `±4%/h` cap이 `MAX_RATE_SCALED = 4n * RATE_SCALE / 100n`으로 bigint로 정확하게 계산됨.
- `rawPayment = notional * cappedRate / RATE_SCALE` — 전체 계산이 bigint로 수행됨.
- `rateNum` (Number 변환)이 표시용에만 사용되고 재무 계산에는 사용되지 않음. 명확한 주석 포함.
- Hyperliquid ±4%/h 기준과 정확히 일치 (기존 CLAUDE.md의 ±600% cap에서 수정됨).

**발견된 문제:**

**[중요] applyFunding()이 결제를 온체인으로 제출하지 않음:**
`FundingRateEngine`은 `'payment'` 이벤트를 발행하지만, `index.ts`에서 이 이벤트를 구독하여 `settleFunding()` 온체인 호출을 트리거하는 코드가 없다. 펀딩 결제가 오프체인 이벤트로만 발행되고 실제 온체인 결제로 이어지지 않는다.

```typescript
// index.ts에 없는 코드:
// fundingEngine.on('payment', (payment) => {
//   settlementWorker.enqueueFunding(payment)
// })
```

**[제안] computeRate()의 Number() 사용:**
`computeRate()`가 `Number(markPrice - indexPrice) / Number(indexPrice)`를 사용한다. 이 함수는 `FundingRate` 타입을 반환하며 외부에 노출된다. 가격이 `2^53`을 초과하는 경우(KRW 기준으로 가능) 정밀도 손실이 발생한다. `bigint` 기반 `rateScaled` 필드를 반환하거나 안전 범위 체크를 추가해야 한다.

### 4.6 ConditionalOrderEngine.ts — 등급: A

**잘 된 점:**
- 반복 중 `[...this.pending]` 스냅샷으로 수정 중 반복을 방지 (G-8 iteration snapshot fix).
- 만료된 주문을 체결 없이 정리하고 `'expired'` 이벤트 발행.
- `submitFn` 실패 시 주문을 `pending`에 재삽입하여 영구 손실 방지.
- `isTriggered()` 방향 로직이 dYdX v4 조건부 주문 시맨틱과 일치.

**발견된 문제:**

**[제안] 재삽입 후 무한 재시도 위험:**
`submitFn` 실패 시 `pending.set(id, entry)`로 재삽입하면, 다음 가격 업데이트마다 재시도된다. 일시적 오류에는 적합하지만 영구적 오류(잘못된 주문)에는 무한 루프를 유발할 수 있다. 최대 재시도 횟수 또는 backoff 전략이 필요하다.

### 4.7 InsuranceFundSyncer.ts — 등급: A-

**잘 된 점:**
- `watchContractEvent`로 `LiquidationFeeRouted` 이벤트를 실시간 구독.
- `resolvePairId` 콜백으로 온체인 `bytes32` pairId와 오프체인 문자열 pairId를 매핑.
- `'synced'` / `'unknown'` / `'error'` 이벤트로 모니터링 가능한 상태 노출.

**발견된 문제:**

**[중요] 재시작 시 놓친 이벤트:**
서버 재시작 후 `start()` 이전에 발생한 `LiquidationFeeRouted` 이벤트는 처리되지 않는다. 오프체인 보험기금 잔액이 온체인 실제 잔액과 영구적으로 낮게 표시될 수 있다. 과거 이벤트 조회(block range 기반) 초기화가 필요하다.

### 4.8 MarkPriceOracle.ts — 등급: A-

**잘 된 점:**
- P1/P2/mid 3-component median 구조가 Orderly Network 문서와 정확히 일치.
- `_computeP1()`이 `indexPrice * rateScaled * timeScaled / (RATE_SCALE * RATE_SCALE)`로 분모 전 분자를 곱하여 정수 정밀도 보존.
- `rateScaled: bigint` 타입 사용으로 `Number(10n**18n)` 언더플로 방지.

**발견된 문제:**

**[제안] TWAP 가중치 없음:**
`getTwap()`이 단순 산술 평균을 계산한다. 실제 TWAP는 시간 가중 평균이어야 한다. 짧은 시간 내 많은 거래가 발생하면 TWAP 값이 왜곡될 수 있다.

**[제안] P2의 spreadHistory가 tradedAt 기준으로 pruning:**
`onTrade()`에서 `list.filter(t => t.ts >= cutoff)`를 수행한다. `_computeP2()`에서 다시 `history.filter(h => h.ts >= cutoff)`를 수행한다. 중복 pruning이 발생하나 기능적 문제는 없다.

### 4.9 PositionTracker.ts — 등급: C+

**발견된 문제 (상위에서 반복):**

**[Critical] getAll()이 margin=0n 반환:**
앞서 언급한 바와 같이 이는 가장 심각한 버그이다. 테스트넷 배포 전 반드시 수정이 필요하다.

**[중요] taker 포지션 추적 없음:**
`onMatch()`가 `match.makerOrder.maker`의 포지션만 업데이트한다. taker의 포지션이 추적되지 않는다.

```typescript
// PositionTracker.ts:12-16
onMatch(pairId: string, match: MatchResult): void {
  const k = this.key(match.makerOrder.maker, pairId)
  // match.takerOrder.maker 포지션 업데이트 없음!
}
```

이는 테이커가 포지션을 열더라도 청산 엔진이 해당 포지션을 볼 수 없음을 의미한다.

### 4.10 MarginAccount.ts — 등급: B+

**잘 된 점:**
- `cross / isolated` 모드별 `effectiveMargin` 계산이 올바름.
- `requiredMargin()` 정적 메서드가 `leverage <= 0n` 입력에 대해 예외를 발생.
- `applyPnl()`이 잔액이 0 아래로 내려가지 않도록 처리 (`newBal < 0n ? 0n : newBal`).

**발견된 문제:**

**[중요] MarginAccount와 PositionTracker의 분리:**
`MarginAccount`가 포지션과 잔액을 별도 Map으로 추적하지만, `PositionTracker`도 포지션을 추적한다. 두 시스템이 별도로 관리되며 `index.ts`에서 동기화되지 않는다. 단일 진실 소스가 없어 상태 불일치 위험이 있다.

---

## 5. 보안 고려사항 (Security Considerations)

### 5.1 재진입 보호 (Reentrancy Protection)

모든 상태 변경 함수에 `nonReentrant` 가드가 적용됨. HybridPool은 `nonReentrant + lock` 이중 보호 (Curve 2023 패턴). **평가: 양호.**

### 5.2 오라클 신뢰 모델 (Oracle Trust Model)

**[중요] 신뢰 집중도:**
`OracleAdmin.postMarkPrice()`는 `OPERATOR_ROLE` 단일 호출로 mark price를 설정한다. 오퍼레이터 키가 탈취되면 청산 조작이 가능하다. 멀티시그 오퍼레이터 또는 마크 가격 업데이트에 별도 역할을 사용할 것을 권장한다. ±20% 델타 가드가 1차 방어선이지만 충분하지 않다.

### 5.3 서명 검증 (Signature Verification)

EIP-712 타입해시가 `isLiquidation` 플래그를 포함하여 정확하게 구성됨. `hashOrder()`가 모든 필드를 포함하므로 주문 필드 변조 불가.

**[제안] EIP-712 체인 ID 포함:**
`__EIP712_init("KRW DEX", "1")`이 체인 ID를 포함하여 도메인 세퍼레이터를 설정하지만, HyperEVM에서 체인 ID가 변경될 경우 재배포가 필요하다.

### 5.4 접근 제어 (Access Control)

- OPERATOR_ROLE: 결제, 청산, ADL, 오라클 업데이트 권한 — 중앙화 위험 존재.
- 테스트/시뮬레이션 전 이 역할을 멀티시그로 운영할 것을 강력히 권장한다.
- `BasicCompliance.blockAddress()` 비대칭(OPERATOR block, ADMIN unblock)이 적절한 견제.

### 5.5 플래시 론 방어 (Flash Loan Defense)

`HybridPool.lastLiquidityChangeBlock` 검사가 동일 블록 내 유동성 추가/스왑 조합을 방지. **평가: 양호.**

### 5.6 경제적 공격 벡터 (Economic Attack Vectors)

**[중요] ADL 자금 미분배:**
`settleADL()`로 수집된 자금이 `OrderSettlement`에 잠긴다. 이 자금을 손실 측 포지션에 실제로 보상하는 메커니즘이 없다. 프로토콜이 ADL을 실행하여 수익 포지션에서 자금을 빼내지만 손실 측이 실제로 보상받지 못하는 상태이다.

---

## 6. 테스트 커버리지 품질 (Test Coverage Quality)

### 6.1 컨트랙트 테스트

**확인된 테스트 파일:**
- `OrderSettlement.t.sol` — 기본 결제, 서명 검증
- `OrderSettlement.settleADL.t.sol` — ADL 10개 시나리오 (스킵, 실패, 이벤트)
- `OrderSettlement.settleFunding.t.sol` — 펀딩 결제
- `OrderSettlement.liquidation.t.sol` — 청산 슬리피지 캡
- `Security.t.sol` — 리플레이 공격, 차단 주소, 가디언 pause, 만료 주문

**평가:** 컨트랙트 테스트가 핵심 happy path와 주요 보안 체크를 커버한다. 다음이 부족하다:
- HybridPool decimal 정규화 부재에 대한 테스트 없음.
- `isUnderMargin()` 경계값 테스트 부족.
- `rampA()` 중간 보간값 정확도 테스트 없음.
- 퍼즈 테스트가 CLAUDE.md에 언급되었으나 테스트 디렉터리에서 `.t.sol` 파일로 확인되지 않음.

### 6.2 서버 테스트

**확인된 주요 테스트:**
- `LiquidationEngine.test.ts` — 9개 청산 + 8개 ADL 시나리오, 엣지 케이스 포함
- `FundingRateEngine.test.ts` — cap 경계값, 방향성, 주기 관리
- `ConditionalOrderEngine.test.ts` — 스냅샷 반복, 만료, 오류 재삽입
- `InsuranceFundSyncer.test.ts` — 동기화, unknown pairId 처리

**평가:** 서버 테스트가 개별 컴포넌트 수준에서 매우 철저하다. 다음이 부족하다:
- `PositionTracker.getAll()` margin=0n 버그에 대한 테스트 없음 (버그를 발견하지 못함).
- `FundingRateEngine` payment 이벤트 → 온체인 `settleFunding()` 연결 테스트 없음.
- 프로세스 재시작 시 상태 복구 테스트 없음.
- 통합 테스트(`api.test.ts`)에 청산 엔진이 포함되지 않음.

---

## 7. 잘 된 점 (Strengths)

1. **bigint 일관성:** 서버 전체에서 재무 수학이 bigint로 수행됨. `Number()` 변환이 표시/로깅에만 사용되며 주석으로 명시. CLAUDE.md의 코딩 기준이 철저히 지켜짐.

2. **CEI 패턴 적용:** `OrderSettlement._settle()`, `InsuranceFund.withdraw()`, `FeeCollector.depositFee()`가 CEI를 올바르게 적용 (InsuranceFund.deposit() 예외 있음).

3. **문서화 수준:** NatSpec이 모든 주요 함수에 적용됨. 설계 결정 사항(`NOTE: Intentionally use raw transferFrom`, `This function must remain external`) 등이 인라인 주석으로 명확히 설명됨.

4. **ConditionalOrderEngine 스냅샷 패턴:** `[...this.pending]` 이터레이션 중 Map 수정 방지가 올바르게 구현됨.

5. **InsuranceFundSyncer-pairIdMap 설계:** 온체인 `bytes32` pairId와 오프체인 문자열 pairId의 매핑이 우아하게 처리됨.

6. **HybridPool 이중 재진입 방어:** `nonReentrant + lock/notLocked` 패턴이 write-write와 read-only 재진입을 모두 방어.

7. **배포 스크립트 2단계 분리:** `Deploy.s.sol`과 `Config.s.sol`의 역할 분리가 배포 오류 위험을 줄임.

8. **STP 3-mode 완전 구현:** Paradex 참조 기준 EXPIRE_TAKER/MAKER/BOTH 모두 올바른 시맨틱으로 구현됨.

---

## 8. 개선이 필요한 점 (Issues & Risks)

### Critical (반드시 수정)

| ID | 컴포넌트 | 문제 |
|----|---------|------|
| CR-1 | PositionTracker.ts | `getAll()`이 `margin=0n` 반환 → 모든 포지션이 즉시 청산 대상으로 판단됨 |
| CR-2 | PositionTracker.ts | taker 포지션이 추적되지 않음 |
| CR-3 | OrderSettlement.sol | `settleADL()` 수집 자금이 컨트랙트에 영구 잠김 |
| CR-4 | FundingRateEngine.ts | `'payment'` 이벤트가 온체인 `settleFunding()` 호출로 연결되지 않음 |
| CR-5 | HybridPool.sol | decimal 정규화 없음 (USDC 6 decimal vs KRW 18 decimal) |

### Important (테스트넷 전 수정 권장)

| ID | 컴포넌트 | 문제 |
|----|---------|------|
| IMP-1 | OrderSettlement.sol | taker 서명 선택적 검증이 NatSpec에 명시되지 않음 |
| IMP-2 | OrderSettlement.sol | `settleLiquidation()` fillAmt가 이미 체결된 양 무시 |
| IMP-3 | InsuranceFund.sol | `deposit()` CEI 역전 (주석 불일치) |
| IMP-4 | LiquidationEngine.ts | `price=0n` 청산 주문이 온체인 `quoteAmount=0` 유발 |
| IMP-5 | InsuranceFundSyncer.ts | 재시작 시 놓친 이벤트 — 보험기금 잔액 불정확 |
| IMP-6 | Deploy.s.sol | MockERC20을 프로덕션 배포 스크립트에서 import |
| IMP-7 | index.ts | `SIGINT` 미처리 — liquidationInterval 미정리 |
| IMP-8 | MarginAccount.ts | PositionTracker와 이중 상태 추적 — 단일 진실 소스 필요 |

### Suggestions (향후 개선)

| ID | 컴포넌트 | 제안 |
|----|---------|------|
| SUG-1 | OracleAdmin.sol | `postMarkPrice()`에 staleness 체크 추가 |
| SUG-2 | MarginRegistry.sol | `addMargin()`에 isolated 모드 전용 가드 추가 |
| SUG-3 | PairRegistry.sol | 비활성 페어 삭제 또는 페이지네이션 지원 |
| SUG-4 | MatchingEngine.ts | `as any` 제거, `_paused` 속성 정식 구현 |
| SUG-5 | ConditionalOrderEngine.ts | 재시도 횟수 상한선 또는 backoff 전략 |
| SUG-6 | FundingRateEngine.ts | `computeRate()` Number() 사용 → bigint 기반으로 |
| SUG-7 | MarkPriceOracle.ts | TWAP에 시간 가중치 적용 |
| SUG-8 | HybridPool.sol | pause() 역할을 GUARDIAN_ROLE로 변경하여 타 컨트랙트와 일관성 유지 |

---

## 9. 오픈소스 정렬도 (Open-Source Alignment)

### dYdX v4 패턴

| 기능 | dYdX v4 | HyperKRW | 정렬도 |
|------|---------|---------|--------|
| CLOB 매칭 알고리즘 | Go memclob, price-time priority | TS OrderBook, price-time priority | 높음 |
| 펀딩 공식 | `rate = (mark-index)/index` | 동일 공식 | 높음 |
| ADL 랭킹 | unrealizedPnL% / margin | effectiveLeverage (proxy) | 중간 (entry price 없어 proxy 사용) |
| 비트맵 논스 | OrderId 기반 | `nonceBitmap[user][wordIndex]` | 높음 (Seaport 패턴) |

### Hyperliquid 패턴

| 기능 | Hyperliquid | HyperKRW | 정렬도 |
|------|------------|---------|--------|
| 펀딩 cap | ±4%/h | ±4%/h (G-1 수정 후) | 완전 일치 |
| ADL 방향 | 고레버리지 고수익 우선 | effectiveLeverage 내림차순 | 높음 |
| 청산 단계 | partial liquidation | 20% per step, max 5 | 근접 (단계 수 차이) |

### Orderly Network 패턴

| 기능 | Orderly | HyperKRW | 정렬도 |
|------|---------|---------|--------|
| 마크 가격 공식 | P1/P2/midPrice median | 동일 구조 | 완전 일치 |
| EIP-712 결제 | 오프체인 매칭 + 온체인 결제 | 동일 패턴 | 높음 |
| 청산 fee | 0.6~1.2% | 0.5% (InsuranceFund로) | 근접 |

**전체 평가:** HyperKRW는 open source 참조 구현을 충실히 반영하고 있으며, KRW 특화 변경사항(스테이블코인 AMM, KRW 오라클 타임록)이 적절히 문서화되어 있다.

---

## 10. 테스트넷 배포 리스크 평가 (Testnet Risk Assessment)

### 즉각적 리스크 (배포 전 필수 수정)

**CR-1 (PositionTracker margin=0n):** 서버 시작 즉시 모든 포지션이 청산 대상으로 표시되어 청산 폭풍이 발생할 수 있다. 테스트넷에서도 즉각 재현 가능한 버그이다.

**CR-5 (HybridPool decimal):** USDC/USDT를 실제로 사용하면 풀 수학이 왜곡된다. KRW-USDC 스왑이 완전히 잘못된 금액을 반환한다.

### 중간 리스크 (초기 테스트넷에서 발견 가능)

**CR-3 (ADL 자금 잠김):** ADL이 트리거되면 자금이 컨트랙트에 잠기며 손실 포지션이 보상받지 못한다. 기능이 반쪽짜리 상태이다.

**CR-4 (펀딩 온체인 미결제):** 펀딩 결제가 오프체인 이벤트로만 발행되고 실제 토큰 이동이 없다. 테스트넷에서 펀딩 기능이 작동하지 않는 것처럼 보일 것이다.

### 낮은 리스크 (초기 테스트넷에서 허용 가능)

- 서버 재시작 시 상태 소실 (개발/테스트넷에서 예상됨)
- InsuranceFundSyncer 재시작 시 이벤트 누락
- `computeRate()` Number() 정밀도 (KRW 가격 범위에서 허용 가능)

---

## 11. 다음 단계 권장사항 — 프론트엔드 (Next Phase Recommendations)

### 11.1 프론트엔드 개발 전 필수 수정

1. **PositionTracker 리팩토링:** `getAll()`이 실제 마진을 포함하도록 수정. `MarginAccount`와 통합하거나 `onMatch()` 시 마진을 계산하여 추적.

2. **taker 포지션 추적:** `PositionTracker.onMatch()`에서 maker와 taker 모두 업데이트.

3. **FundingRateEngine → SettlementWorker 연결:** `'payment'` 이벤트를 구독하여 배치 펀딩 결제를 온체인으로 제출하는 워커 구현.

4. **HybridPool decimal 정규화:** `_calcSwapCurve()`에서 토큰별 decimal 정규화 배율을 적용.

5. **Deploy.s.sol에서 MockERC20 import 분리:** 테스트넷용 `DeployTestnet.s.sol`과 프로덕션용 `Deploy.s.sol`을 분리.

### 11.2 프론트엔드 API 설계를 위한 권장사항

**REST API 엔드포인트:**
- `GET /positions/:maker` — MarginAccount 기반 포지션 조회 (margin 포함)
- `GET /funding/rate/:pairId` — 현재 펀딩 레이트 및 예상 결제 금액
- `GET /insurance/:pairId` — 오프체인 보험기금 잔액 (InsuranceFund.getSnapshot())
- `GET /liquidations/recent` — 최근 청산 이벤트 (LiquidationEngine EventEmitter 구독)

**WebSocket 스트림:**
- `orderbook/:pairId` — 실시간 오더북 depth
- `trades/:pairId` — 실시간 체결 데이터
- `positions/:maker` — 포지션 업데이트 (마진 변경, 청산 경고)
- `funding/:pairId` — 펀딩 레이트 변화

**프론트엔드 안전을 위한 고려사항:**
- 모든 bigint 값을 JSON으로 전송 시 문자열 변환 필요 (`JSON.stringify`가 bigint를 직렬화하지 못함). 전용 BigInt serializer 미들웨어를 Fastify에 적용할 것.
- 가격 표시 시 18 decimal 정규화를 클라이언트 또는 API 레이어에서 처리해야 함.
- KRW 가격은 숫자가 크므로 (예: ETH = 4,000,000 KRW) 프론트엔드에서 JavaScript Number 대신 BigInt 또는 Decimal.js 사용 권장.

### 11.3 멀티시그 및 운영 보안

메인넷 배포 전:
1. Gnosis Safe 멀티시그로 `DEFAULT_ADMIN_ROLE` 이전 (Config.s.sol 안내 이미 포함).
2. `OPERATOR_ROLE` 키를 HSM(Hardware Security Module) 또는 MPC 서명자로 관리.
3. 오라클 업데이트와 청산 실행에 별도 오퍼레이터 주소 사용 (최소 권한 원칙).
4. 독립 보안 감사 (특히 OrderSettlement, HybridPool, ADL 흐름 중점).

---

## 결론 (Conclusion)

HyperKRW DEX는 KRW 스테이블코인 퍼페추얼 DEX로서 기술적으로 야심차고 체계적인 프로젝트이다. 전체 구조, 오픈소스 정렬, 테스트 커버리지 모두 프로젝트 규모 대비 높은 수준을 달성했다.

그러나 **CR-1 (PositionTracker margin=0n), CR-3 (ADL 자금 잠김), CR-4 (펀딩 온체인 미결제), CR-5 (HybridPool decimal)**은 테스트넷에서도 즉각 문제가 발생할 수 있는 버그이다. 이 4개 이슈를 수정한 후 테스트넷 배포를 진행하는 것을 강력히 권장한다.

프론트엔드 단계로 진입하기 전, 위 Critical 및 Important 이슈들을 해결하고 재리뷰를 통해 검증하는 것이 현명한 접근법이다.

---

*이 리뷰는 실제 소스 파일을 직접 읽어 작성되었습니다.*
*주요 참조 파일:*
- `krw-dex-contracts/src/OrderSettlement.sol`
- `krw-dex-contracts/src/InsuranceFund.sol`
- `krw-dex-contracts/src/MarginRegistry.sol`
- `krw-dex-contracts/src/HybridPool.sol`
- `krw-dex-contracts/src/OracleAdmin.sol`
- `krw-dex-contracts/script/Deploy.s.sol`
- `krw-dex-contracts/script/Config.s.sol`
- `krw-dex-server/src/index.ts`
- `krw-dex-server/src/core/matching/MatchingEngine.ts`
- `krw-dex-server/src/core/liquidation/LiquidationEngine.ts`
- `krw-dex-server/src/core/funding/FundingRateEngine.ts`
- `krw-dex-server/src/core/conditional/ConditionalOrderEngine.ts`
- `krw-dex-server/src/core/oracle/MarkPriceOracle.ts`
- `krw-dex-server/src/core/position/PositionTracker.ts`
- `krw-dex-server/src/core/insurance/InsuranceFund.ts`
- `krw-dex-server/src/core/insurance/InsuranceFundSyncer.ts`
- `krw-dex-server/src/margin/MarginAccount.ts`
