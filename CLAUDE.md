# HyperKRW Server — CLAUDE.md

This is the **HyperKRW DEX Server**: off-chain CLOB matching engine for the HyperKRW DEX built on HyperEVM.

- **Repo:** https://github.com/justin7361-stack/krw-dex-server
- **Stack:** TypeScript, Node.js, Fastify, Vitest
- **Companion contracts repo:** https://github.com/justin7361-stack/HyperEVM-KRW-DEX

---

## 세션 규칙 (Session Rules)

### 세션 시작 시 반드시:
1. `docs/`의 **모든 `*_review.md` 파일** (`1st_review.md`, `2nd_review.md` 등)과 `docs/research.md`를 읽어 이전 리뷰 결과, 알려진 버그, 설계 결정 히스토리를 숙지
2. `docs/tmr_todo.md` (또는 컨트랙트 레포의 `docs/tmr_todo.md`) 읽기 — 현재 태스크, 우선순위, 설계 결정사항 파악
3. `git log --oneline -10` 실행 — 최근 커밋 히스토리로 맥락 파악
4. GitHub 레포 전체 진행사항 확인 후 현재 상태 파악하고 시작
5. 새로운 todo 작성 시 반드시 review.md의 Critical/Important 이슈를 반영하여 우선순위 결정

### 세션 종료 시 반드시:
1. `docs/tmr_todo.md` 업데이트:
   - 단순 할 일 목록이 아니라 **각 태스크의 설계 결정사항, 주의사항, 다음 세션에 알아야 할 것**까지 상세히 기록
   - 완료된 태스크는 커밋 해시와 함께 기록
   - 다음에 이어서 할 태스크 명확히 표시
   - **사용자가 직접 해야 하는 작업**도 별도 섹션(`## 🙋 사용자 직접 실행 필요`)에 명확히 기록하고 세션 시작 시 리마인드
2. 작업 내용 GitHub에 커밋/푸시

---

## 컨텍스트 관리 규칙 (Context Management)

### 세션 분리 원칙
3개 레포(krw-dex-server / HyperEVM-KRW-DEX / krw-dex-web)를 동시에 다루면 컨텍스트가 빠르게 소모된다.
**레포 1개 = 세션 1개** 원칙을 기본으로 한다.

| 세션 유형 | 담당 레포/범위 | 예시 |
|---------|-------------|------|
| Server 세션 | `krw-dex-server` 단독 | 버그 수정, 인프라, API 추가 |
| Contract 세션 | `HyperEVM-KRW-DEX` 단독 | Solidity 버그, 배포 스크립트 |
| Frontend 세션 | `krw-dex-web` 단독 | UI 버그, 컴포넌트 추가 |
| Infra/Deploy 세션 | docker-compose, traefik, Railway | Phase Q 배포 |

### 새 세션이 필요한 신호 (Claude가 알려줄 것)
Claude는 다음 상황 중 하나에 해당하면 **작업 완료 후 즉시** 사용자에게 알린다:
- 현재 대화가 compacting된 이력이 있고, 다음 태스크가 새 레포/도메인으로 전환될 때
- 현재 태스크가 완료되고 다음 Phase가 **완전히 다른 레포**를 주로 다룰 때
- 컨텍스트 소모가 많아 코드 품질에 영향을 줄 가능성이 보일 때

### 세션 내 계속 진행 가능한 경우
- 같은 레포 내에서 연속 작업 중일 때
- compacting이 발생하지 않았고 컨텍스트가 충분할 때
- 다음 태스크가 이미 이 세션에서 충분히 논의된 설계 위에 있을 때

### tmr_todo.md가 세션 간 핵심 인수인계 수단
- compaction/새 세션 후에도 `tmr_todo.md`의 커밋 해시 + 설계 결정사항만 있으면 맥락 복원 가능
- 따라서 **종료 전 tmr_todo.md를 충분히 상세하게 쓰는 것이 최우선**

---

## Project Architecture

```
src/
├── api/
│   ├── routes/         # Fastify route handlers (orders, admin, etc.)
│   └── server.ts       # Server factory (buildServer)
├── chain/
│   └── contracts.ts    # viem contract clients
├── compliance/
│   └── PolicyEngine.ts # Blocklist / geo-block compliance
├── core/
│   ├── funding/        # FundingRateEngine — ±600% cap, 8h intervals
│   ├── insurance/      # InsuranceFund (in-memory) + IInsuranceFund interface
│   ├── liquidation/    # LiquidationEngine — 20% partial, max 5 steps
│   ├── matching/       # MatchingEngine — CLOB off-chain matching
│   ├── oracle/         # MarkPriceOracle — 3-component P1/P2/midPrice median
│   ├── orderbook/      # OrderBook + IOrderBookStore interface
│   └── position/       # PositionTracker
├── margin/
│   └── MarginAccount.ts  # Cross/Isolated margin accounting
├── types/
│   └── order.ts        # Order, StoredOrder, MarginPosition, StpMode, etc.
├── verification/       # EIP-712 signature verification
└── index.ts            # Entry point — wires all engines together
```

---

## 개발 철학 (Development Philosophy)

### 오픈소스 우선 원칙 (Open Source First)

**항상 상용화를 염두에 두고, 새 기능을 개발하기 전에 반드시 오픈소스를 먼저 비교 분석한다.**

#### 의사결정 순서
```
1. 기능 요구사항 정의
2. 동종 오픈소스 구현 조사 (dYdX v4, Hyperliquid, Orderly, Paradex 등)
3. 포킹 vs. 직접 구현 판단:
   ┌─ 포킹/참조 우선 조건:
   │   - 검증된 알고리즘 (CLOB price-time priority, 펀딩 공식 등)
   │   - 업계 표준 패턴 (주문 상태 머신, 청산 트리거 로직 등)
   │   - KRW 특화 수정이 최소인 경우
   └─ 직접 구현 조건:
       - KRW 기반 구조로 전면 수정이 필요한 경우
       - 오픈소스가 다른 언어라 변환 비용 > 직접 작성 비용 (예: dYdX Go → TS)
       - HyperKRW 고유 기능 (STP 3-mode, bigint 재무 수학 등)
4. 포킹/참조 시: docs/research.md 섹션 14.6에 출처 기록
5. 직접 작성 시: research.md의 참조 구현과 비교 검증 후 차이 문서화
```

#### 주요 참조 오픈소스 (서버)
| 컴포넌트 | 1차 참조 | 비고 |
|---------|---------|------|
| CLOB 매칭 알고리즘 | [dYdX v4 memclob](https://github.com/dydxprotocol/v4-chain/tree/main/protocol/x/clob/memclob) | Go→TS 변환, 알고리즘 동일 |
| 마크 가격 공식 | [Orderly mark price](https://orderly.network/docs/build-on-omnichain/trade-data/mark-price) | P1/P2/median 구조 동일 |
| 펀딩 레이트 공식 | [dYdX funding](https://docs.dydx.xyz/trading/funding) + [HL funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) | 하이브리드 구현 |
| 파셜 청산 20% | [Paradex liquidation](https://docs.paradex.trade/documentation/risk-management/liquidations) | 단계 수 차이 있음 |
| STP 3-mode | [Paradex STP](https://docs.paradex.trade/) | 기본값 EXPIRE_TAKER |

---

## Coding Standards

### TypeScript / Financial Math
- **All financial math in `bigint`** — never use `Number()` for calculations
- Use `10n ** 18n` not `BigInt(1e18)` (the latter loses precision above 2^53)
- `Number()` is acceptable ONLY for display/logging — never in calculations
- No `as any` casts — use proper types or narrow interfaces

### Key Types
- `StpMode`: `'EXPIRE_TAKER' | 'EXPIRE_MAKER' | 'EXPIRE_BOTH'` (Self-Trade Prevention)
- `MarginMode`: `'cross' | 'isolated'`
- `MarginPosition`: `{ maker, pairId, size: bigint, margin: bigint, mode }`
- `IInsuranceFund`: narrow DI interface — avoids coupling to EventEmitter concrete class
- `MarkPriceOracle.getFundingRate` getter returns `{ rateScaled: bigint; timestamp: number }` (bigint, NOT number)

### Perp Engine Constants
- Funding rate cap: ±600% (`MAX_RATE_SCALED = 6n * RATE_SCALE`)
- Liquidation: 20% per step, max 5 steps, `liquidationSteps` Map auto-cleans at step 5
- Mark price: `median(P1, P2, midPrice)` — P1 uses `rateScaled: bigint` (pre-scaled by 1e18)
- Maintenance margin: 250 bps (2.5%)

### Testing
- Use Vitest (`npx vitest run`)
- `tsc --noEmit` must be clean before committing
- Tests should cover edge cases, not just happy paths

---

## Important Design Decisions

### MarkPriceOracle
- `getFundingRate` getter returns `{ rateScaled: bigint; timestamp: number }` — NOT `{ rate: number; ... }`
- This avoids unsafe `Number(10n**18n)` conversion (exceeds MAX_SAFE_INTEGER)
- `_computeP1`: multiplies all numerators BEFORE dividing: `indexPrice * rateScaled * timeScaled / (RATE_SCALE * RATE_SCALE)`

### InsuranceFund (in-memory)
- `IInsuranceFund` narrow interface used for DI to avoid coupling to EventEmitter
- `cover()` emits `'adl_needed'` event when shortfall occurs

### LiquidationEngine
- `submitLiquidationOrder` does NOT take a `step` param — caller is responsible for position size updates
- `liquidationSteps` Map auto-deletes at step 5 (final step)

### MarginAccount
- Cross mode: `effectiveMargin = totalBalance` (full balance available)
- Isolated mode: `effectiveMargin = freeMargin` (totalBalance - sum of isolated margins)
- `requiredMargin(notional, leverage)` static method — floors at `1n`, throws on ≤ 0 leverage

---

## Development Commands

```bash
npx vitest run          # run all tests
npx vitest run <path>   # run specific test file
npx tsc --noEmit        # typecheck
```
