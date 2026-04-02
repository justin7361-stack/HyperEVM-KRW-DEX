# HyperKRW DEX — Session Todo

**마지막 업데이트:** 2026-04-02
**현재 상태:** 테스트넷 배포 전 필수 작업 완료 → D-1 배포 준비 완료

---

## ✅ 완료된 작업

### G-1~G-9 (이전 세션 — 서버)
| 태스크 | 커밋 |
|-------|------|
| G-1: 펀딩 레이트 캡 ±4%/h | `5d8dbae` |
| G-4: ADL 대상 순위 (effectiveLeverage) | `7250879` |
| G-5~G-7: IOC/FOK/POST_ONLY/Reduce-Only | `8092546` |
| G-8: SL/TP 조건부 주문 엔진 | `602d85f` |
| G-9: InsuranceFundSyncer 구현 | `aaeb688` |

### A-1~A-5 (이번 세션 — 테스트넷 배포 전 필수 작업)
| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| A-1: Deploy.s.sol | contracts `ed3120f` | InsuranceFund(step6) + MarginRegistry(step7) 추가 |
| A-2: Config.s.sol | contracts `ed3120f` | setLiquidationFee(50) + setLiquidationInsuranceFund() |
| A-3 Fix1 | server `f96e6f9` | positionTracker → MatchingEngine 3번째 인자로 전달 |
| A-3 Fix2 | server `f96e6f9` | InsuranceFundSyncer 시작 + PairIdResolver 구현 |
| A-3 Fix3 | server `f96e6f9` | FundingRateEngine.startPair() 각 활성 페어별 호출 |
| A-4 | server `f96e6f9` | .env.example에 INSURANCE_FUND_ADDRESS 추가 |
| A-5 | server `f96e6f9` | PAIR_REGISTRY_ABI에 getAllPairIds() + pairs() 추가 |

---

## 🔴 다음 작업: D-1 테스트넷 배포

### 배포 전 체크리스트
- [ ] HyperEVM testnet 계정 준비 (DEPLOYER_PRIVATE_KEY, ADMIN_ADDRESS 등)
- [ ] .env 파일 작성 (krw-dex-contracts/.env)

```bash
DEPLOYER_PRIVATE_KEY=0x...
ADMIN_ADDRESS=0x...
OPERATOR_ADDRESS=0x...        # 서버 운영 지갑
GUARDIAN_ADDRESS=0x...        # 긴급 pause 권한 지갑
USDC_ADDRESS=                 # 테스트넷 USDC (없으면 MockERC20 자동 배포)
USDT_ADDRESS=                 # 테스트넷 USDT (없으면 skip)
ADMIN_PRIVATE_KEY=0x...       # Config.s.sol용 admin 키
```

### 배포 순서
```bash
# 1. 컨트랙트 빌드
cd krw-dex-contracts
~/.foundry/bin/forge build

# 2. 배포 (9개 컨트랙트)
~/.foundry/bin/forge script script/Deploy.s.sol \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
  --broadcast --verify
# 출력된 주소들을 .env에 기록

# 3. 설정 (역할 부여 + 청산 수수료 설정)
~/.foundry/bin/forge script script/Config.s.sol \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
  --broadcast
```

### 서버 환경변수 (.env) 작성 후
```bash
cd krw-dex-server
cp .env.example .env
# 배포된 주소 입력

npm run build
npm start
# 로그에서 확인:
# [Startup] Loaded N pair(s) from PairRegistry
# InsuranceFundSyncer isRunning=true
```

### E2E 검증
1. 테스트 지갑 2개로 매수/매도 주문 제출
2. SettlementWorker가 `settleBatch()` txn 발행 확인
3. `OrderFilled` 이벤트 온체인 확인

---

## 📋 전체 개발 로드맵 (D-1 이후)

### F-* 프론트엔드 MVP
**스택:** Next.js 14 + wagmi v2 + viem + Tailwind + shadcn/ui + TanStack Query
**레포:** `krw-dex-web` (신규 생성)

| 태스크 | 예상 | 내용 |
|-------|------|-----|
| F-1: 프로젝트 셋업 | 1일 | Next.js 14, wagmi, HyperEVM config |
| F-2: 트레이딩 화면 | 3~4일 | 오더북, 주문 폼, 캔들차트, 포지션 패널 |
| F-3: 지갑 연동 | 2일 | EIP-712 서명, 마진 입출금 UI |
| F-4: AMM Swap | 2일 | HybridPool KRW↔USDC swap UI |
| F-5: 포트폴리오 | 2일 | 자산, PnL, 펀딩 내역 |

### M-* 모바일
| 태스크 | 예상 | 내용 |
|-------|------|-----|
| M-1: PWA 전환 | 1일 | next-pwa, 반응형, Add to Home Screen |
| M-2: React Native | 2~3주 | Expo, WalletConnect v2, push notification |

### A-* Admin 대시보드
- 실시간 통계, 청산 현황, InsuranceFund 잔액, 서킷브레이커 UI

### P-* 프로덕션 강화
- DB 영속성 (PostgreSQL/Redis)
- 실제 오라클 연동 (Pyth/Chainlink)
- 컨트랙트 감사 (audit)
- 메인넷 배포

---

## 🔧 설계 결정사항 메모

### PairIdResolver 구현 방식
- `PairRegistry.getAllPairIds()` → `pairs(pairId)` 순차 호출로 매핑 빌드
- on-chain pairId: `keccak256(encodePacked(baseToken, quoteToken))`
- off-chain pairId: `"0xBASE/0xQUOTE"` (MatchingEngine/OrderBook 내부 key)
- 새 페어 추가 시 서버 재시작 필요 (동적 갱신은 추후 구현)

### FundingRateEngine 시작 조건
- `pair.active === true` 인 페어만 시작
- 비활성화된 페어: 다음 서버 재시작 때 자동 제외

### MatchingEngine + PositionTracker 순서
- `positionTracker` 먼저 생성 후 `MatchingEngine` 3번째 인자로 전달
- reduce-only 주문이 올바르게 검증됨

### InsuranceFundSyncer 오류 처리
- PairRegistry 호출 실패 시 try/catch로 graceful degradation
- 서버는 계속 시작되되 pairIdMap = empty (InsuranceFund sync 비활성)
- 배포 후 컨트랙트 주소 설정하면 자동 작동
