# HyperKRW DEX Contracts — Session Todo

**마지막 업데이트:** 2026-04-02
**현재 상태:** 테스트넷 배포 전 필수 작업 완료 → D-1 준비 완료

---

## ✅ 완료된 작업

### G-2/G-3: 청산 수수료 + InsuranceFund 자동 충전 (`77c2289`)
- `OrderSettlement.sol`: liquidationFeeBps, liquidationInsuranceFund 추가
- `_executeTransfers`: feeReceiver 분기 (InsuranceFund vs FeeCollector)
- 132/132 테스트 통과

### A-1~A-2: 배포 스크립트 완성 (`ed3120f`)
- `Deploy.s.sol`: InsuranceFund(step6) + MarginRegistry(step7) 추가
  - InsuranceFund.initialize(admin, settlement, guardian)
  - MarginRegistry.initialize(admin, settlement)
- `Config.s.sol`: setLiquidationFee(50) + setLiquidationInsuranceFund() 추가
- `PairRegistry.sol`: getAllPairIds() view 함수 추가 (서버 startup용)

---

## 🔴 다음 작업: D-1 테스트넷 배포

### 환경 준비
```bash
# krw-dex-contracts/.env
DEPLOYER_PRIVATE_KEY=0x...    # 배포자 키
ADMIN_PRIVATE_KEY=0x...       # admin 키 (Config.s.sol용)
ADMIN_ADDRESS=0x...
OPERATOR_ADDRESS=0x...        # 서버 운영 지갑 주소
GUARDIAN_ADDRESS=0x...
USDC_ADDRESS=                 # 테스트넷 USDC (비우면 MockERC20 자동 배포)
INSURANCE_FUND_ADDRESS=0x...  # Deploy 후 채움
MARGIN_REGISTRY_ADDRESS=0x... # Deploy 후 채움
FEE_COLLECTOR_ADDRESS=0x...   # Deploy 후 채움
ORDER_SETTLEMENT_ADDRESS=0x...
PAIR_REGISTRY_ADDRESS=0x...
ORACLE_ADMIN_ADDRESS=0x...
```

### 배포 + 설정 명령
```bash
~/.foundry/bin/forge build

# Step 1: 컨트랙트 배포 (9개)
~/.foundry/bin/forge script script/Deploy.s.sol \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
  --broadcast

# 출력된 주소들을 .env에 입력 후:

# Step 2: 역할 설정 + 청산 수수료 설정
~/.foundry/bin/forge script script/Config.s.sol \
  --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
  --broadcast
```

### 배포 후 검증
- [ ] 9개 컨트랙트 주소 기록 (`deployments/testnet.json` 생성 권장)
- [ ] InsuranceFund.OPERATOR_ROLE → settlement 확인
- [ ] OrderSettlement.liquidationFeeBps == 50 확인
- [ ] OrderSettlement.liquidationInsuranceFund == insuranceFund 확인

---

## 📋 배포 후 로드맵

### 페어 등록 (Config 이후)
```solidity
// PairRegistry에 ETH/KRW 등 페어 추가
PairRegistry(registry).addToken(ethAddr, false, false);
PairRegistry(registry).addPair(ethAddr, krwAddr, 1e15, 1e15, 1e18, 1e24);
```

### 프론트엔드 (F-*) — 별도 레포 `krw-dex-web`
- F-1: Next.js 14 + wagmi 셋업
- F-2: 트레이딩 화면 (오더북, 주문, 차트, 포지션)
- F-3: 지갑 연동 + EIP-712 서명
- F-4: HybridPool Swap UI

### 컨트랙트 감사 준비 (P-*)
- CEI 패턴 ✅
- UUPS 프록시 ✅
- liquidationFeeBps max 200 bps 하드캡 ✅
- 재진입 방어 ✅

---

## 🔧 설계 결정사항 메모

### Deploy.s.sol InsuranceFund 초기화
- `operator = address(settlement)` — settlement가 deposit() 직접 호출
- OPERATOR_ROLE은 초기화 시 영구 부여 (추가 트랜잭션 불필요)

### Config.s.sol liquidationFee
- 50 bps = 0.5% — Hyperliquid 표준 범위 내
- 상한: 200 bps (2%) — OrderSettlement에 하드코딩된 최대값

### PairRegistry.getAllPairIds()
- 서버가 startup 시 페어 목록 가져와 PairIdResolver 빌드에 사용
- 비활성 페어도 포함 (서버에서 active 플래그로 필터링)
