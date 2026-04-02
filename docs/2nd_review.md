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

### 3.8 FeeCollector.sol — 등급: A

**잘 된 점:**
- `depositFee()` Effect-before-Interaction 패턴 올바름.
- `DEPOSITOR_ROLE` 별도 구분으로 불필요한 권한 부여 최소화.

### 3.9 Deploy.s.sol / Config.s.sol — 등급: A-

**잘 된 점:**
- `Deploy.s.sol`이 `InsuranceFund.initialize(admin, address(settlement), guardian)`으로 settlement를 OPERATOR로 자동 설정.
- `Config.s.sol` 마지막에 "Transfer admin role to Gnosis Safe multisig" 안내 출력.

**발견된 문제:**

**[중요] MockERC20 import가 배포 스크립트에 포함:**
테스트 목 컨트랙트가 프로덕션 배포 스크립트에 포함되어 있다. 테스트넷 전용 `DeployTestnet.s.sol`과 프로덕션용 `Deploy.s.sol`을 분리해야 한다.

---

## 4. 서버 상세 리뷰 (Server Component Review)

### 4.1 index.ts — 등급: A-

**잘 된 점:**
- 컴포넌트 와이어링이 선형적이고 가독성이 높음.
- `SIGTERM` 핸들러가 모든 엔진을 순서대로 정지시킴 (graceful shutdown).
- 시작 시 `pairRegistry.read.getAllPairIds()`로 온체인 페어를 로드하고 실패 시 경고만 발행.

**발견된 문제:**

**[중요] liquidationInterval이 SIGTERM 외에서 정리되지 않음:**
`SIGINT` (Ctrl+C) 또는 `uncaughtException`에서 종료 시 인터벌이 정리되지 않을 수 있다.

### 4.2 MatchingEngine.ts — 등급: A-

**발견된 문제:**

**[중요] `(this as any)._paused` 패턴:**
`as any` 캐스트는 TypeScript 타입 안전성을 우회한다. `private _paused = false` 속성과 `pause()` / `resume()` 메서드를 정식으로 구현해야 한다.

### 4.3 OrderBook.ts — 등급: A

**잘 된 점:**
- Price-time priority, STP 3-mode, POST_ONLY, FOK, IOC 완전 구현.
- FOK TOCTOU 경쟁 조건에 대한 주석 문서화.

### 4.4 LiquidationEngine.ts — 등급: B+

**잘 된 점:**
- `selectADLTargets()`의 effectiveLeverage 랭킹 알고리즘이 Hyperliquid/dYdX v4 패턴과 일치.

**발견된 문제:**

**[중요] PositionTracker.getAll()이 margin=0n을 반환:**
```typescript
// PositionTracker.ts:31-38
return [...this.pos.entries()].map(([key, size]) => {
  return { maker, pairId, size, margin: 0n, mode: 'cross' as const }
  //                             ^^^^^^^^ 항상 0!
})
```
`LiquidationEngine.checkPositions()`에서 `pos.margin`을 사용하여 청산 여부를 판단하는데, `margin`이 항상 `0n`이면 모든 포지션이 즉시 청산 대상이 된다. **이것이 현재 코드베이스에서 가장 심각한 버그이다.**

**[제안] submitLiquidationOrder의 가격이 0n:**
온체인 `OrderSettlement.settle()`에 전달될 때 `price=0`이면 `quoteAmount = 0`이 되어 토큰 이동이 전혀 없는 문제가 발생한다. 온체인 청산 결제 시 실제 mark price를 사용해야 한다.

### 4.5 FundingRateEngine.ts — 등급: A-

**잘 된 점:**
- `±4%/h` cap이 bigint로 정확하게 계산됨. Hyperliquid 기준과 완전 일치.

**발견된 문제:**

**[중요] applyFunding()이 결제를 온체인으로 제출하지 않음:**
`FundingRateEngine`은 `'payment'` 이벤트를 발행하지만, `index.ts`에서 이 이벤트를 구독하여 `settleFunding()` 온체인 호출을 트리거하는 코드가 없다. 펀딩 결제가 오프체인 이벤트로만 발행되고 실제 온체인 결제로 이어지지 않는다.

### 4.6 ConditionalOrderEngine.ts — 등급: A

**잘 된 점:**
- `[...this.pending]` 스냅샷으로 수정 중 반복 방지.
- `submitFn` 실패 시 재삽입으로 영구 손실 방지.

### 4.7 InsuranceFundSyncer.ts — 등급: A-

**잘 된 점:**
- `watchContractEvent`로 `LiquidationFeeRouted` 이벤트 실시간 구독.
- `'synced'` / `'unknown'` / `'error'` 이벤트로 모니터링 가능한 상태 노출.

**발견된 문제:**

**[중요] 재시작 시 놓친 이벤트:**
서버 재시작 후 `start()` 이전에 발생한 이벤트는 처리되지 않는다. 과거 이벤트 조회(block range 기반) 초기화가 필요하다.

### 4.8 MarkPriceOracle.ts — 등급: A-

**잘 된 점:**
- P1/P2/mid 3-component median 구조가 Orderly Network 문서와 정확히 일치.
- `rateScaled: bigint` 타입 사용으로 정밀도 손실 방지.

### 4.9 PositionTracker.ts — 등급: C+

**[Critical] getAll()이 margin=0n 반환:**
테스트넷 배포 전 반드시 수정이 필요하다.

**[중요] taker 포지션 추적 없음:**
```typescript
// PositionTracker.ts:12-16
onMatch(pairId: string, match: MatchResult): void {
  const k = this.key(match.makerOrder.maker, pairId)
  // match.takerOrder.maker 포지션 업데이트 없음!
}
```
taker가 포지션을 열더라도 청산 엔진이 해당 포지션을 볼 수 없다.

### 4.10 MarginAccount.ts — 등급: B+

**잘 된 점:**
- `cross / isolated` 모드별 `effectiveMargin` 계산이 올바름.

**발견된 문제:**

**[중요] MarginAccount와 PositionTracker의 분리:**
두 시스템이 별도로 관리되며 동기화되지 않는다. 단일 진실 소스가 없어 상태 불일치 위험이 있다.

---

## 5. 보안 고려사항 (Security Considerations)

### 5.1 재진입 보호
모든 상태 변경 함수에 `nonReentrant` 가드 적용. HybridPool은 `nonReentrant + lock` 이중 보호. **평가: 양호.**

### 5.2 오라클 신뢰 모델
`OracleAdmin.postMarkPrice()`는 `OPERATOR_ROLE` 단일 호출로 mark price를 설정한다. 오퍼레이터 키가 탈취되면 청산 조작이 가능하다. 멀티시그 오퍼레이터 권장.

### 5.3 서명 검증
EIP-712 타입해시가 `isLiquidation` 플래그를 포함하여 정확하게 구성됨.

### 5.4 접근 제어
OPERATOR_ROLE이 결제, 청산, ADL, 오라클 업데이트 권한을 모두 가진다. 중앙화 위험 존재.

### 5.5 플래시 론 방어
`HybridPool.lastLiquidityChangeBlock` 검사로 동일 블록 내 유동성 추가/스왑 조합 방지. **평가: 양호.**

### 5.6 경제적 공격 벡터
`settleADL()`로 수집된 자금이 `OrderSettlement`에 잠긴다. 손실 측 포지션에 실제로 보상하는 메커니즘이 없다.

---

## 6. 테스트 커버리지 품질 (Test Coverage Quality)

### 서버 테스트 강점
- `LiquidationEngine.test.ts` — 9개 청산 + 8개 ADL 시나리오
- `FundingRateEngine.test.ts` — cap 경계값, 방향성, 주기 관리
- `ConditionalOrderEngine.test.ts` — 스냅샷 반복, 만료, 오류 재삽입
- `InsuranceFundSyncer.test.ts` — 동기화, unknown pairId 처리

### 누락된 테스트
- `PositionTracker.getAll()` margin=0n 버그 탐지 테스트 없음
- `FundingRateEngine` payment 이벤트 → 온체인 `settleFunding()` 연결 테스트 없음
- 통합 테스트에 청산 엔진 미포함

---

## 7. 잘 된 점 (Strengths)

1. **bigint 일관성:** 재무 수학 전체가 bigint로 수행됨. CLAUDE.md 코딩 기준 철저히 준수.
2. **CEI 패턴 적용:** `OrderSettlement._settle()`, `FeeCollector.depositFee()` 올바름.
3. **문서화 수준:** NatSpec 및 인라인 주석으로 설계 결정사항 명확히 설명.
4. **ConditionalOrderEngine 스냅샷 패턴:** `[...this.pending]` Map 수정 방지.
5. **InsuranceFundSyncer-pairIdMap 설계:** 우아한 bytes32↔string 매핑.
6. **HybridPool 이중 재진입 방어:** write-write + read-only 재진입 모두 방어.
7. **배포 스크립트 2단계 분리:** Deploy.s.sol + Config.s.sol 역할 분리.
8. **STP 3-mode 완전 구현:** EXPIRE_TAKER/MAKER/BOTH 모두 올바른 시맨틱.

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
| SUG-8 | HybridPool.sol | pause() 역할을 GUARDIAN_ROLE로 변경 |

---

## 9. 오픈소스 정렬도 (Open-Source Alignment)

| 기능 | 참조 | 정렬도 |
|------|------|--------|
| CLOB 매칭 | dYdX v4 memclob | 높음 |
| 펀딩 공식/cap | dYdX v4 + Hyperliquid (±4%/h) | 완전 일치 |
| ADL 랭킹 | effectiveLeverage (dYdX proxy) | 높음 |
| 비트맵 논스 | Seaport 패턴 | 높음 |
| 마크 가격 P1/P2/mid | Orderly Network | 완전 일치 |
| EIP-712 결제 | Orderly EVM contracts | 높음 |
| StableSwap 수학 | Curve 2-pool | 높음 |

---

## 10. 테스트넷 배포 리스크 평가 (Testnet Risk Assessment)

### 즉각적 리스크 (배포 전 필수 수정)

**CR-1 (PositionTracker margin=0n):** 서버 시작 즉시 모든 포지션이 청산 대상으로 표시되어 청산 폭풍이 발생할 수 있다. 테스트넷에서도 즉각 재현 가능한 버그이다.

**CR-5 (HybridPool decimal):** USDC/USDT를 실제로 사용하면 풀 수학이 왜곡된다. KRW-USDC 스왑이 완전히 잘못된 금액을 반환한다.

### 중간 리스크 (초기 테스트넷에서 발견 가능)

**CR-3 (ADL 자금 잠김):** ADL이 트리거되면 자금이 컨트랙트에 잠기며 손실 포지션이 보상받지 못한다.

**CR-4 (펀딩 온체인 미결제):** 펀딩 결제가 오프체인 이벤트로만 발행되고 실제 토큰 이동이 없다.

### 낮은 리스크 (테스트넷에서 허용 가능)

- 서버 재시작 시 상태 소실
- InsuranceFundSyncer 재시작 시 이벤트 누락
- `computeRate()` Number() 정밀도

---

## 11. 다음 단계 권장사항

### 11.1 Critical 수정 순서 (우선순위)

1. **CR-1/CR-2: PositionTracker 리팩토링** — `getAll()`이 실제 마진을 포함하도록. `onMatch()`에서 maker + taker 모두 추적.
2. **CR-4: FundingRateEngine → SettlementWorker 연결** — `'payment'` 이벤트 구독하여 온체인 settleFunding() 호출.
3. **CR-5: HybridPool decimal 정규화** — `rates[]` 배열로 토큰별 decimal 정규화.
4. **CR-3: settleADL() 자금 분배** — 수집 자금을 InsuranceFund 또는 손실 포지션으로 이동.

### 11.2 프론트엔드 API 설계

**REST API 엔드포인트:**
- `GET /positions/:maker` — MarginAccount 기반 포지션 조회 (margin 포함)
- `GET /funding/rate/:pairId` — 현재 펀딩 레이트
- `GET /insurance/:pairId` — 오프체인 보험기금 잔액

**WebSocket 스트림:**
- `orderbook/:pairId` — 실시간 오더북 depth
- `trades/:pairId` — 실시간 체결 데이터
- `positions/:maker` — 포지션 업데이트

**프론트엔드 안전을 위한 고려사항:**
- 모든 bigint를 JSON 전송 시 문자열 변환 필요 (Fastify BigInt serializer 미들웨어 적용).
- KRW 가격은 숫자가 크므로 클라이언트에서 BigInt 또는 Decimal.js 사용 권장.

### 11.3 멀티시그 및 운영 보안 (메인넷 전)

1. Gnosis Safe 멀티시그로 `DEFAULT_ADMIN_ROLE` 이전.
2. `OPERATOR_ROLE` 키를 HSM 또는 MPC 서명자로 관리.
3. 독립 보안 감사 (OrderSettlement, HybridPool, ADL 흐름 중점).

---

## 결론 (Conclusion)

HyperKRW DEX는 기술적으로 야심차고 체계적인 프로젝트이다. 전체 구조, 오픈소스 정렬, 테스트 커버리지 모두 프로젝트 규모 대비 높은 수준을 달성했다.

그러나 **CR-1 (PositionTracker margin=0n), CR-3 (ADL 자금 잠김), CR-4 (펀딩 온체인 미결제), CR-5 (HybridPool decimal)**은 테스트넷에서도 즉각 문제가 발생할 수 있는 버그이다. 이 4개 이슈를 수정한 후 테스트넷 배포를 진행하는 것을 강력히 권장한다.

---

*이 리뷰는 실제 소스 파일을 직접 읽어 작성되었습니다. (2026-04-02)*
