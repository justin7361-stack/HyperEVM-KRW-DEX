# HyperKRW DEX — Session Todo

**마지막 업데이트:** 2026-04-06 (세션 4)
**현재 상태:** Phase S-0 (테스트넷 전 크리티컬 수정) 완료. 28 test files, 251 tests all passing. tsc --noEmit clean. Phase Q (테스트넷 배포)만 남음 (사용자 직접 실행 필요)

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

## ✅ 완료 — 세션 2 추가 작업 (2026-04-06)

| 태스크 | 레포 | 커밋 | 내용 |
|-------|------|------|-----|
| R-3: TransferToGnosisSafe | contracts `38b6000` | Gnosis Safe로 DEFAULT_ADMIN_ROLE 이전 스크립트 + 테스트 5개 |
| R-2: VaultClient | server `88ae7fa` | AppRole 인증, operator key Vault에서 읽기, .env 폴백 |
| entryPrice + unrealizedPnl | server `cd75efd` | PositionTracker 가중평균 entryPrice, /positions 실제 PnL 반환 |
| settleFunding 온체인 | server `a750dc5` | FundingPayment → OrderSettlement.settleFunding() 배치 콜 |
| CircuitBreaker (R-7) | server `38f55c2` | 가격밴드(10%/1분) 자동 중단, POST /admin/halt\|resume, GET /admin/halted |
| WS markprice/funding push | server `38f55c2` | markprice.update 5초, funding.update 30초 WS 푸시 |
| Frontend WS 연동 | web `3427d9d` | useFundingRate WS 캐시 업데이트, useMarkPrice 훅 신규 |
| Indexer 프로덕션 설정 | indexer `b736f46` | .env.example 정리, Dockerfile HEALTHCHECK 추가 |

## ✅ 완료 — 세션 3 추가 작업 (2026-04-06)

| 태스크 | 레포 | 커밋 | 내용 |
|-------|------|------|-----|
| OpenAPI/Swagger 문서 | server `f489164` | @fastify/swagger v8 + swagger-ui v4, buildServer() async, /docs UI |
| WalletRateLimiter | server `edc205e` | 슬라이딩 윈도우 Map, 429 응답 + retryAfter, 60s 클린업 |
| Admin 서킷브레이커 UI | web `b20ac39` | AdminPage 신규: 서킷브레이커 halt/resume, 404 NotFoundPage |
| PositionTracker EventEmitter | server `f489164` | extends EventEmitter, 'position.updated' 이벤트 emit |
| WS position.update 푸시 | server `38f55c2` | stream.ts positionTracker 구독 → 해당 pairId WS 클라이언트로 push |
| usePositions WS 실시간 | web `af0058e` | 'position.update' WS 수신 → TanStack 캐시 즉시 업데이트 |
| Vite 코드 스플리팅 | web `5417717` | manualChunks 4개, 모든 페이지 React.lazy() + Suspense |
| OrderForm markPrice WS | web `9c2f9ac` | useMarkPrice → effectiveMarkPrice(WS\|\|REST) OrderForm/PositionPanel |
| Playwright E2E 테스트 | web `b9015ca` | playwright.config.ts + e2e/ (navigation, health, orderbook) |
| Contract Natspec | contracts `1fa6d80` | 7개 컨트랙트 @title/@notice/@dev 문서화, 137/137 forge tests 통과 |

---

## ✅ 완료 — Phase R-2 (Vault OSS 키 관리) + R-4 (Timelock)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| R-2: Vault OSS scaffold | server `d12bace` | vault/vault.hcl (TLS+audit+HSM upgrade path), vault/policies/{operator,oracle}.hcl, vault/setup.sh (KV v2 + AppRole 자동화) |
| R-2: /health 강화 | server `d12bace` | {status,ts,version,checks{matching,db,pubsub}}, 503 on degraded, db/pubsub 전달 |
| R-4: TimelockController | contracts `a915918` | script/SetupTimelock.s.sol — 48h 딜레이, 7개 컨트랙트 DEFAULT_ADMIN_ROLE 이전, struct 패턴 |

**R-2 Vault 사용자 직접 실행 필요 항목:** 아래 🙋 섹션 참조 (R-2 항목)

---

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

## ✅ 완료 — Phase S-0 (테스트넷 전 크리티컬 수정, 2026-04-06)

| 태스크 | 커밋 | 내용 |
|-------|------|-----|
| SUG-1: MarkPriceOracle 타임스탬프 | `fd2dcb0` | getMarkPriceWithTs() 추가 — { price, ts } 반환 |
| IMP-4: liquidation price=0n 버그 | `fd2dcb0` | LiquidationEngine: markPrice 사용, 0n 가드 추가 |
| SUG-1: 스테일니스 체크 | `fd2dcb0` | STALE_THRESHOLD_MS=5분, 5분 초과 시 청산 건너뜀 |
| IMP-8: MarginAccount 이중 상태 | `9f9621b` | PositionTracker 단일 소스, positions Map 제거 |
| IMP-8: server.ts 연결 | `9f9621b` | new MarginAccount(positionTracker), server.ts/orders.test.ts 동기화 |
| SUG-6: FundingRateEngine Number() 주석 | `d0318fd` | computeRate() display-only 명시적 주석 |

**검증 결과:**
- `npx tsc --noEmit`: 에러 0개
- `npx vitest run`: 28 파일, 251 테스트 all passed
- `git push origin master`: `43ec703..d0318fd`

---

## 🔴 다음 작업: Phase Q 테스트넷 배포

### ✅ Claude가 준비 완료한 파일들 (커밋 `950b0de`, `ecc4634`, contracts `a915918`)
- `script/DeployTestnet.s.sol` — 원클릭 배포 스크립트 (deploy + config + pair등록 + 토큰민팅 합산)
- `script/SetupTimelock.s.sol` — R-4: TimelockController (48h 업그레이드 딜레이) 배포 + admin 이전
- `railway.toml` — Railway 배포 설정
- `docker-compose.yml` + `Dockerfile` — 셀프호스팅용 (indexer 서비스 포함)
- `src/db/init-indexer-db.sql` — krwdex_indexer DB 초기화
- `.env.example` 업데이트 — INSURANCE_FUND_ADDRESS, START_BLOCK 포함
- `traefik/dynamic/middlewares.yml` — API 게이트웨이 설정
- `krw-dex-indexer/` (신규 레포) — Ponder 인덱서 (O-3):
  - ponder.config.ts, ponder.schema.ts, src/{OrderSettlement,InsuranceFund,OracleAdmin,PairRegistry}.ts
  - 8개 테이블 (Trade, Liquidation, FundingSettlement, AdlEvent, InsuranceFundDeposit/Cover, MarkPrice, Pair)
  - docker-compose.yml의 `indexer` 서비스로 통합됨

---

## 🙋 사용자 직접 실행 필요

### 인덱서 GitHub 리모트 설정 (1회)
```bash
# 1. GitHub에서 새 레포 생성: https://github.com/new
#    이름: krw-dex-indexer
# 2. 로컬에서:
cd ~/krw-dex-indexer
git remote add origin https://github.com/justin7361-stack/krw-dex-indexer.git
git push -u origin master
```

### R-2: HashiCorp Vault 서버 실행 (메인넷 준비 시)
```bash
# 1. Vault Docker 실행
docker run -d --name vault \
  -p 8200:8200 \
  -v $(pwd)/vault/vault.hcl:/vault/config/vault.hcl \
  -v vault_data:/vault/data \
  -v vault_tls:/vault/tls \
  --cap-add=IPC_LOCK \
  hashicorp/vault:latest server

# 2. 초기화 (unseal 키 5개 + root token 안전하게 저장!)
export VAULT_ADDR=https://vault.hyperkrw.xyz
vault operator init    # 출력을 오프라인에 보관

# 3. 봉인 해제 (3/5 키 사용)
vault operator unseal  # x3

# 4. 셋업 스크립트 실행 (root token으로)
export VAULT_TOKEN=<root-token>
bash vault/setup.sh

# 5. root token 폐기
vault token revoke $VAULT_TOKEN

# 6. 서버에 VAULT_ROLE_ID + VAULT_SECRET_ID 환경변수 설정
```

### Q-1: HYPE 테스트넷 토큰 확보 (선행 필수)
```
1. https://faucet.hyperliquid-testnet.xyz 에서 HYPE 토큰 받기
2. Deployer 지갑 + Operator 지갑 모두 HYPE 필요
   (gas fee용: 각 0.1 HYPE면 충분)
```

### Q-2: 컨트랙트 배포 (forge)
```bash
cd krw-dex-contracts

# 1. .env.testnet 작성
cp .env.testnet.example .env.testnet
# DEPLOYER_PRIVATE_KEY, OPERATOR_ADDRESS, GUARDIAN_ADDRESS 입력

# 2. 빌드 확인
~/.foundry/bin/forge build

# 3. 배포 (single script: deploy + config + pair등록 + 토큰민팅)
source .env.testnet
~/.foundry/bin/forge script script/DeployTestnet.s.sol \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
  --broadcast

# 4. 출력된 주소들을 krw-dex-server/.env 와 krw-dex-web/.env.local에 복사
#    스크립트가 "=== .env COPY-PASTE ===" 형식으로 출력해줌
```

### Q-3: 서버 배포 — Railway (권장) 또는 Docker
**Railway:**
```bash
cd krw-dex-server
railway login
railway init          # 프로젝트 연결
# Railway 대시보드에서 .env.example 변수 모두 설정
# PostgreSQL add-on 추가 → DATABASE_URL 자동 설정
# Redis add-on 추가 → REDIS_URL 자동 설정
railway up
```

**Docker (셀프호스팅):**
```bash
cd krw-dex-server
cp .env.example .env   # 주소 채워넣기
docker compose up -d   # postgres + redis + traefik + server 모두 시작
```

### Q-4: Traefik TLS 설정 (Docker 셀프호스팅 시)
```bash
# ACME_EMAIL, API_DOMAIN 환경변수 설정 후 docker compose up
# Let's Encrypt 자동 발급 (포트 80/443 열려있어야 함)
```

### Q-5: 프론트엔드 배포 — Vercel
```bash
cd krw-dex-web
# .env.local에 배포된 컨트랙트 주소 + API URL 입력
vercel deploy --prod
# 또는 GitHub 연동 → 자동 배포
```

### Q-6: MetaMask E2E 검증
```
1. MetaMask에 HyperEVM Testnet 추가
   - RPC: https://rpc.hyperliquid-testnet.xyz/evm
   - Chain ID: 998
   - Symbol: HYPE
2. 배포된 프론트엔드에서:
   a. 지갑 연결
   b. MockKRW approve → depositMargin
   c. 매수 주문 제출 (EIP-712 서명)
   d. 다른 지갑으로 매도 주문 제출
   e. 체결 확인 → PositionPanel 업데이트 확인
   f. HyperEVM explorer에서 OrderFilled 이벤트 확인
```

### Q-7: WalletConnect Project ID 발급 (선택, RainbowKit용)
```
1. https://cloud.walletconnect.com 에서 프로젝트 생성 (무료)
2. Project ID를 krw-dex-web/.env.local의 VITE_WALLETCONNECT_PROJECT_ID에 입력
```

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
