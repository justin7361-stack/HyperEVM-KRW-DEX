# HyperKRW DEX — Session Todo

**마지막 업데이트:** 2026-04-06
**현재 상태:** Phase M/N/P/O 완료 → Phase Q (테스트넷 배포) 준비 완료

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

## ✅ 완료 — Phase M (서버 크리티컬 버그)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| M-1 CR-1: PositionTracker margin=0n | 이전 세션 | PositionState {size, margin, mode} 구조로 변경 |
| M-2 CR-2: taker 포지션 미추적 | 이전 세션 | onMatch()에서 maker+taker 모두 업데이트 |
| M-3 CR-4: FundingEngine payment 이벤트 연결 | 이전 세션 | fundingEngine.on('payment') 콘솔 로깅 (온체인 연결 TODO) |
| M-4 IMP-7: SIGINT 핸들러 추가 | 이전 세션 | gracefulShutdown() 리팩터, SIGTERM+SIGINT 모두 처리 |

## ✅ 완료 — Phase N (컨트랙트 크리티컬 버그)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| N-1 CR-3: settleADL 자금 InsuranceFund 전송 | 이전 세션 | collected → IInsuranceFundDeposit.deposit() 호출 |
| N-2 CR-5: HybridPool decimal 정규화 | 이전 세션 | _precisionMultipliers() + xp 정규화, forge test 132/132 |
| N-3 IMP-3: InsuranceFund CEI 수정 | 이전 세션 | Effects(state) → Interactions(transferFrom) 순서 보정 |

## ✅ 완료 — Phase P (프론트엔드 버그)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| P-1: AccountPage approve 플로우 | 이전 세션 | approveWrite + allowance read krwAddr로 수정 |
| P-2: MarginForm 에러 표시 | 이전 세션 | approveError, marginError 렌더링 |
| P-3: window.innerWidth → useMediaQuery | 이전 세션 | src/hooks/useMediaQuery.ts 신규, MediaQueryList 이벤트 |
| P-4: keyRole 타입 정렬 | 이전 세션 | 'read'\|'trade' (서버와 일치), ApiKeyModal 수정 |
| P-5: Toast 피드백 시스템 | 이전 세션 | src/components/ui/Toast.tsx, CSS 애니메이션, alert() 제거 |
| P-6: 청산 거리 방향 수정 | 이전 세션 | isLong prop, Long: markPrice-liqPrice, Short: 반전 |

## ✅ 완료 — Phase O (인프라)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| O-1: PostgreSQL 스키마+DB | `d808f6e` | src/db/schema.sql, database.ts, IDatabase, NullDatabase, PostgresDatabase |
| O-2: Redis WS pub/sub | `d808f6e` | src/pubsub/RedisPubSub.ts, IPubSub, LocalPubSub, RedisPubSubImpl |
| O-4: viem fallback RPC | `d808f6e` | contracts.ts fallback([primary, secondary]), config.rpcUrlFallback |
| O-5: Traefik 게이트웨이 | `d808f6e` | traefik/dynamic/middlewares.yml (rate-limit 100/s, security headers, admin allowlist) |
| O-6: Docker Compose | `d808f6e` | docker-compose.yml (server+postgres+redis+traefik), Dockerfile 멀티스테이지 |
| O-7: OFAC+AuditLog | `d808f6e` | OFACPlugin(로컬SDN+Chainalysis), AuditLog(구조화 JSON), index.ts 연결 |

**주의사항:**
- `postgres`/`ioredis` 는 선택적 런타임 dep — `npm install postgres ioredis` 실행해야 사용 가능
- Docker Compose는 `WITH_POSTGRES=1 WITH_REDIS=1` 빌드 인자로 optional dep 자동 설치
- O-3 (Ponder 인덱서)는 별도 서비스, 미구현 — Phase Q 배포 후 필요 시 추가

---

## 🔴 다음 작업: Phase Q 테스트넷 배포

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
