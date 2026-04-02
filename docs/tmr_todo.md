# HyperKRW DEX Server — Session Todo

## 완료된 작업 (Completed)

### G-1: 펀딩 레이트 캡 재정의 (`5d8dbae`)
- `FundingRateEngine.ts`: `MAX_RATE_SCALED` ±600% → ±4%/h, default interval 8h → 1h
- 음수 극단도 올바르게 클램핑되도록 수정
- 15개 테스트 통과

### G-2/G-3: 청산 수수료 + InsuranceFund 자동 충전 (`77c2289`, contracts repo)
- `OrderSettlement.sol`: `liquidationFeeBps`, `liquidationInsuranceFund` 상태 변수 추가
- `_settleSinglePair`: `canRoute = feeBps > 0 && fundAddr != address(0)` 조건 → fee=0 when not routable
- `_executeTransfers`: `feeReceiver` 파라미터 추가 — non-zero → InsuranceFund.deposit(), zero → FeeCollector
- `test/OrderSettlement.liquidation.t.sol`: 6개 G-2 테스트 추가, 132/132 통과

### G-4: ADL 대상 순위 정책 (`7250879`)
- `LiquidationEngine.ts`: `selectADLTargets()` 메서드 + `ADLCandidate` 인터페이스 추가
- 알고리즘: 반대 방향 필터 → effectiveLeverage 스코어링 → 내림차순 정렬 → totalLoss 커버까지 누적
- 18개 테스트 통과

### G-5~G-7: IOC/FOK/POST_ONLY/Reduce-Only 주문 타입 (`8092546`)
- `MatchingEngine.ts`: `IPositionReader` 인터페이스 추가, `reduceOnly` 체크 구현
- `OrderBook.tif.test.ts`: IOC 4개 테스트 추가 (기존 FOK/POST_ONLY 유지)
- `MatchingEngine.reduceOnly.test.ts`: 8개 테스트 (방향별 허용/거부, positionReader 없는 경우)
- 185/185 통과

### G-8: Stop-Loss/Take-Profit 조건부 주문 엔진 (`602d85f`)
- `ConditionalOrderEngine.ts`: `EventEmitter` 상속, `expiry` 체크, `getCount()`, 이벤트 방출
- 핵심 버그 수정: `[...this.pending]` 스냅샷으로 에러 재큐 후 동일 루프 재처리 방지
- 이벤트: `'triggered'`, `'expired'`, `'error'`
- 12/12 테스트 통과

### G-9: InsuranceFund 온체인↔인메모리 동기화 (`aaeb688`)
- `abis.ts`: `LiquidationFeeRouted` 이벤트 ABI 추가
- `InsuranceFundSyncer.ts`: `LiquidationFeeRouted` 이벤트 감시 → `fund.deposit()` 적용
- `PairIdResolver`: bytes32(온체인) → string(오프체인) 변환 함수 타입
- 이벤트: `'synced'`, `'unknown'`, `'error'`
- 8/8 테스트 통과, 198/198 전체 통과

---

## 다음 작업 (Next Up)

### D-1: 테스트넷 배포 (Testnet Deployment)
- **조건**: G-1~G-9 완료 ✅ — 이제 진행 가능
- **순서**:
  1. `krw-dex-contracts` → HyperEVM 테스트넷에 배포 (Foundry `forge script`)
  2. 배포된 주소를 `krw-dex-server` 환경 변수로 설정
  3. `InsuranceFundSyncer` + `ChainWatcher` 연결
  4. End-to-end 테스트: 주문 제출 → 매칭 → 온체인 정산 확인

### G-10 이후 검토 사항 (from research.md Section 14)
- **G-10**: 크로스마진 모드 정밀 구현 (현재 cross = 전체 잔고)
- **G-11**: 마크가격 외부 인덱스 연동 (현재 `setIndexPrice`만 존재)
- **G-12**: 주문장 영속성 (현재 in-memory only)
- **G-13**: 거버넌스 / 파라미터 변경 on-chain 로깅

---

## 설계 결정사항 메모

### InsuranceFundSyncer PairIdResolver
- 온체인 `pairId = keccak256(abi.encodePacked(baseToken, quoteToken))` (bytes32)
- 오프체인 `pairId = "ETH/KRW"` (string)
- 매핑은 배포 시 초기화: `new Map([[keccak256(...), 'ETH/KRW'], ...])`
- **주의**: 새 페어 추가 시 resolver Map도 업데이트해야 함

### MatchingEngine IPositionReader
- `PositionTracker`가 `IPositionReader` 인터페이스 만족 (별도 어댑터 불필요)
- `new MatchingEngine(store, feeEngine, positionTracker)` 형태로 주입
- `index.ts` (entry point) 에서 wiring 필요

### ConditionalOrderEngine 이터레이션 스냅샷
- `for (const [id, entry] of [...this.pending])` — Map 이터레이션 중 재삽입 방지
- 에러 재큐된 주문은 다음 `onPrice` 호출에서 재처리됨
