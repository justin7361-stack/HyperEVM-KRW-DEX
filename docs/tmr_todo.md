# HyperKRW — 작업 TODO

**최초 작성:** 2026년 3월 31일
**마지막 업데이트:** 2026년 4월 2일
**참고 문서:** `docs/1st_review.md`, `docs/research.md`, `docs/superpowers/plans/`

> 이 파일은 로컬 전용 (GitHub 미푸시). 세션 시작 전 반드시 참고.

---

## 현재 상태 요약 (2026-04-02 기준)

| 영역 | 상태 |
|---|---|
| 스마트 컨트랙트 (기존 6개) | ✅ P0 완료 |
| CLOB 서버 (P0/P1/P2) | ✅ 완료 — 155/155 테스트 통과 |
| Perp 엔진 (서버) | ✅ 완료 — B-1~B-6 모두 완료 |
| 컨트랙트 Perp 지원 | ✅ C-1~C-6 모두 완료 |
| 오픈소스 비교 분석 | ✅ research.md 섹션 14 추가 완료 |
| Admin 대시보드 | ⚠️ 기본 HTML + API 골격만 존재 |
| 트레이딩 프론트엔드 | ❌ 미시작 |
| 모바일 앱 | ❌ 미시작 |
| 테스트넷 배포 | ❌ 미완료 |

---

## PART 1 — 서버 백엔드 (krw-dex-server) — 전체 완료

### ✅ 완료 항목

| 태스크 | 커밋 | 설계 결정사항 / 주의사항 |
|---|---|---|
| B-1 Funding Rate Cap (±600%) | `35d3f2a` | `MAX_RATE_SCALED = 6n * RATE_SCALE`, 상수는 루프 밖에 선언 |
| B-2 부분 청산 (20%, max 5 steps) | `e3dde72` | `liquidationSteps` Map, 5번째 스텝에서 자동 삭제 |
| B-3 InsuranceFund (in-memory) | `3a120db` | `IInsuranceFund` 인터페이스로 DI, EventEmitter와 분리 |
| B-4 STP 모드 확장 | `3d50689` | EXPIRE_TAKER(기본)/EXPIRE_MAKER/EXPIRE_BOTH, 무한루프 방지 가드 추가 |
| B-5 3-component Mark Price | `9fdff95` | `getFundingRate` → `{ rateScaled: bigint }` (number 아님!), `indexPrice * rateScaled * timeScaled / (RATE_SCALE²)` 순서 중요 |
| B-6 Margin 강제 적용 | `6d72bf7` | Cross=totalBalance, Isolated=freeMargin, `requiredMargin` static 메서드, leverage 기본값 1n |

### ⚠️ 다음 세션 주의사항
- `MarkPriceOracle.setFundingRateGetter` 콜백은 반드시 `{ rateScaled: bigint; timestamp: number }` 형태로 반환해야 함 (`rate: number` 아님)
- `MarginAccount.requiredMargin(notional, leverage)` — leverage ≤ 0 이면 throw, 결과 0n이면 1n 반환

---

## PART 2 — 컨트랙트 Perp 지원 (krw-dex-contracts)

### ✅ 완료 항목

| 태스크 | 커밋 | 설계 결정사항 / 주의사항 |
|---|---|---|
| C-1 settleFunding() | `48f8a7f` | `bytes32 pairId` (string 아님), int256.min 가드, 9시간 staleness 체크, try/catch로 best-effort |
| C-2 InsuranceFund.sol | `a46ad31` | `mapping(bytes32 => mapping(address => uint256))` pairId+token 2중 키, CEI 순서(transfer 후 balance 업데이트), deposit() 도 CEI |
| C-3 MarginRegistry.sol | `1c87187` | `isUnderMargin`에 `maintenanceBps > 0` 가드, `size != type(int256).min` 가드, `PausableUpgradeable.EnforcedPause.selector` 타입드 revert |

### ✅ 추가 완료 항목

| 태스크 | 커밋 | 설계 결정사항 / 주의사항 |
|---|---|---|
| C-4 settleADL() | `c9f8630` | best-effort: raw transferFrom (SafeERC20 사용 시 skip 불가), zero-address guard |
| C-5 postMarkPrice() | `a45e5ce` | ±20% 샌티체크, MarkPrice struct (price+timestamp), OPERATOR_ROLE |
| C-6 isLiquidation 플래그 | `f1bc06d` | `settleLiquidation()` (overload 아님!), fee=0, ±5% 슬리피지 캡, _settleSinglePair 내부 헬퍼 |

### 🔴 의존성 주의
- C-4는 C-2(InsuranceFund.sol) 완료 후 시작 가능 → ✅ C-2 완료됨
- C-6는 C-5 완료 후 동일 에이전트에서 처리 → ✅ 완료

---

## PART 3 — Admin 대시보드 (krw-dex-server/src/admin/)

**현재 상태:** `src/admin/public/index.html` (기본 UI 껍데기), `src/admin/routes.ts` (stats/blocklist/pause 5개 API)

#### [A-1] Admin UI 완성 (~6h)
- 실시간 서버 통계, 오더북 depth 시각화, 블록리스트 관리, 서킷브레이커, 청산 현황

#### [A-2] Admin API 확장 (~4h)
- `GET /admin/orders`, `DELETE /admin/orders/:id`, `GET /admin/positions`
- `GET /admin/insurance`, `POST /admin/settlement/force`, `GET /admin/fees`

---

## PART 4~6 — 프론트엔드 / 모바일 / 배포

**현재 상태:** 모두 미시작. 컨트랙트 C-4~C-6 완료 후 배포(D-1~D-3) → 프론트(F-*) 순서 권장.

### 배포 순서 (D-1)
```
PairRegistry → OracleAdmin → BasicCompliance → FeeCollector → OrderSettlement → InsuranceFund → MarginRegistry → HybridPool
```

---

## 전체 로드맵 (현재 기준 업데이트)

```
Phase 1 — 서버 P2 완성 ✅ 완료
  B-4 STP → B-5 Mark Price → B-6 Margin

Phase 2 — 컨트랙트 Perp 지원 🔨 진행 중
  C-1 ✅ → C-2 ✅ → C-3 ✅ → C-4 🔨 → C-5 🔨 → C-6 🔨

Phase 3 — 테스트넷 런칭 (다음)
  D-1 컨트랙트 배포 → D-2 서버 배포 → D-3 CI/CD

Phase 4 — 프론트 MVP
  F-1 스택 결정 → F-2 핵심 화면 → F-3 실시간 연동

Phase 5 — 모바일
  M-1 → M-2

Phase 6 — 프로덕션 강화
  B-7~B-12, Admin 대시보드
```

---

## 다음 세션 시작 기준

**현재:** C-1~C-6 완료 + 오픈소스 비교 분석(research.md 섹션 14) 완료

다음 세션 진행 기준:
```
"tmr_todo.md 참고해서 D-1 테스트넷 배포 작업 시작해줘"
```

**G-1~G-9 모두 완료 (2026-04-02)**:
- G-1: 펀딩 레이트 캡 ±4%/h → 서버 `5d8dbae`
- G-2/G-3: `settleLiquidation()` 수수료 + InsuranceFund 자동 충전 → 컨트랙트 `77c2289`
- G-4: ADL 대상 순위 (effectiveLeverage) → 서버 `7250879`
- G-5~G-7: IOC/FOK/POST_ONLY/Reduce-Only → 서버 `8092546`
- G-8: SL/TP 조건부 주문 엔진 (expiry, events) → 서버 `602d85f`
- G-9: InsuranceFundSyncer (온체인↔인메모리 동기화) → 서버 `aaeb688`

**이제 D-1 테스트넷 배포 진행 가능.**

### 배포 준비 체크리스트
- [ ] `script/Deploy.s.sol` 작성
- [ ] HyperEVM testnet RPC + PRIVATE_KEY 설정
- [ ] InsuranceFund OPERATOR_ROLE → OrderSettlement 부여
- [ ] 서버 환경변수 업데이트 (컨트랙트 주소들)
- [ ] InsuranceFundSyncer PairIdResolver 초기화 (keccak256 → pairString 매핑)
- [ ] MatchingEngine에 PositionTracker 주입 (index.ts wiring)
