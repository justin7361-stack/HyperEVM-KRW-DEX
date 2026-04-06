# CLOB DEX 오픈소스 구현 종합 리서치

**작성일:** 2026년 3월 31일
**목적:** HyperKRW DEX 개발을 위한 레퍼런스 문서
**대상 플랫폼:** dYdX v4, Lighter, Hyperliquid, Paradex, EdgeX, Vertex Protocol, Orderly Network

---

## 목차

1. [Executive Summary — 기능 비교 테이블](#1-executive-summary--기능-비교-테이블)
2. [아키텍처 개요](#2-아키텍처-개요)
3. [주문 유형 (Order Types)](#3-주문-유형-order-types)
4. [매칭 엔진 (Matching Engine)](#4-매칭-엔진-matching-engine)
5. [자기 거래 방지 (STP)](#5-자기-거래-방지-stp)
6. [펀딩 레이트 (Funding Rate)](#6-펀딩-레이트-funding-rate)
7. [오라클/마크 가격 (Oracle / Mark Price)](#7-오라클마크-가격-oracle--mark-price)
8. [청산 엔진 (Liquidation Engine)](#8-청산-엔진-liquidation-engine)
9. [마진 시스템 (Margin System)](#9-마진-시스템-margin-system)
10. [API 설계 패턴](#10-api-설계-패턴)
11. [수수료 구조 (Fee Structure)](#11-수수료-구조-fee-structure)
12. [Client Order ID / 중복 방지](#12-client-order-id--중복-방지)
13. [HyperKRW 권장사항 (Recommendations)](#13-hyperkrw-권장사항-recommendations)

---

## 1. Executive Summary — 기능 비교 테이블

| 기능 | dYdX v4 | Lighter | Hyperliquid | Paradex | EdgeX | Vertex | Orderly |
|------|---------|---------|-------------|---------|-------|--------|---------|
| **체인/레이어** | Cosmos SDK (L1) | zkRollup on ETH | HyperBFT L1 | StarkNet L2 | StarkEx L2 | Arbitrum L2 | OP Stack L2 |
| **매칭 위치** | 온체인 (in-memory) | zk-circuit 증명 | 온체인 (자체 BFT) | 오프체인+ZK | 오프체인 | 오프체인 시퀀서 | 오프체인 시퀀서 |
| **오픈소스** | 완전 오픈소스 | 화이트페이퍼 공개 | 부분 공개 (API) | 부분 공개 | 부분 공개 | 완전 오픈소스 | SDK 오픈소스 |
| **주문 유형** | Market/Limit/Stop/TP/TWAP | Market/Limit/IOC/FOK/Post-Only/GTT/SL/TP/TWAP | Market/Limit/Scale/TWAP/Stop/TP-SL | Market/Limit/Scale/Stop/TWAP/TP-SL | Market/Limit/Conditional | Market/Limit/SL/TP | Market/Limit/IOC/FOK/Post-Only/Reduce-Only |
| **펀딩 주기** | 1시간 (60분 샘플 평균) | 1시간 | 1시간 (8h rate / 8) | 5초 연속 적립 | 1시간 | 1시간 TWAP | 8시간 (1h/4h/8h 가변) |
| **마진 방식** | 크로스 (포트폴리오) | 크로스/아이솔레이티드 | 크로스/아이솔레이티드/Strict Isolated | 크로스 (포트폴리오 마진 예정) | 크로스 (서브계정으로 아이솔레이티드) | 통합 크로스 (spot+perp+MM) | 크로스 |
| **청산 방식** | 오더북 매칭 | 오더북 + 보험펀드 풀 | 오더북 + HLP Vault | 파셜 청산 (20% 단위) | 계정별 독립 | 즉시 청산 + 보험펀드 | 분산 청산 + 보험펀드 |
| **STP** | 미기재 (프로토콜 수준) | 메이커 취소 | 미기재 | Expire Maker/Taker/Both | 미기재 | 미기재 | 미기재 |
| **메이커 수수료** | -1.1 bps (리베이트) | 0% (표준) | 0~-3 bps | -0.5 bps | 미기재 | 0% | 0 bps |
| **테이커 수수료** | ~3 bps | 0% (표준) | 4.5 bps | 0~2 bps | 미기재 | 2 bps | 3 bps |
| **Client Order ID** | clientId (uint32, 서브계정 고유) | 미기재 | cloid (128-bit hex) | 지원 | 미기재 | 지원 | client_order_id |
| **GTT 지원** | ✅ (GoodTilBlockTime) | ✅ | ❌ (GTC만) | ✅ | ✅ (4주) | ✅ | ✅ |
| **TWAP** | ✅ (v9.0+) | ✅ (30초 슬라이스) | ✅ (30초 슬라이스) | ✅ | 미기재 | 미기재 | 미기재 |

---

## 2. 아키텍처 개요

### 2.1 dYdX v4 (Cosmos-based CLOB)

**레포지토리:** https://github.com/dydxprotocol/v4-chain

dYdX v4는 Cosmos SDK와 CometBFT를 기반으로 한 독립적인 소버린 블록체인으로, 고성능 오더북과 매칭 엔진을 구현한다.

**핵심 디렉토리 구조:**
```
protocol/
  x/clob/           # 핵심 CLOB 모듈
    memclob/        # 인메모리 오더북 (MemClobPriceTimePriority)
    keeper/         # 상태 관리 및 비즈니스 로직
    types/          # 주문 타입, 메시지 정의 (order.go, order.proto)
    abci.go         # 블록 제안 및 파이널리제이션
  x/perpetuals/     # 영구 선물 모듈
  x/prices/         # 오라클 가격 모듈 (Slinky)
  x/subaccounts/    # 서브계정 관리
indexer/            # 읽기 전용 인덱서 서비스
```

**특징:**
- 각 풀노드가 독립적인 인메모리 오더북 유지
- 블록 제안자가 로컬 오더북으로 거래 매칭 후 블록 제안
- 합의 완료 후 전체 노드 상태 동기화
- Short-Term Order (20블록 유효, 약 30초) vs Stateful Order (온체인 장기 보관)

### 2.2 Lighter (zkRollup CLOB)

Lighter는 Ethereum 위에서 동작하는 application-specific zk-rollup으로, 모든 주문 매칭과 청산을 zk-SNARK로 증명한다.

**핵심 구조:**
- **Order Book Tree**: Merkle Tree + Prefix Tree 하이브리드 구조. 가격과 nonce를 리프 인덱스로 인코딩
  - Θ(log N) 삽입/삭제/최우선 호가 조회
- **Smart Contract**: Ethereum에 자산과 canonical state root 보관
- zk-proof로 price-time priority와 청산 규칙 강제 적용

### 2.3 Hyperliquid (HyperBFT L1)

자체 HyperBFT 합의 메커니즘(Hotstuff 계열)을 사용하는 독립 L1 블록체인.

**특징:**
- 200,000 주문/초 처리량
- 모든 거래(주문, 취소, 체결, 청산)가 온체인에서 투명하게 실행
- One-block finality
- HyperCore (금융 로직) + HyperEVM (일반 스마트 컨트랙트) 이중 구조

### 2.4 Paradex (StarkNet L2)

StarkNet 기반 ZK-rollup으로, L2 상태 변경의 ZK proof를 L1 컨트랙트가 검증.

**특징:**
- 오프체인 클라우드 매칭 엔진
- 매칭 후 체결을 체인에 전송
- StarkNet 앱체인 구조

### 2.5 EdgeX (StarkEx L2)

StarkEx ZK-rollup 기반의 고성능 Perp DEX. Amber Group 인큐베이팅.

**4-레이어 아키텍처:**
1. **Settlement Layer**: StarkEx ZK-rollup → Ethereum 메인넷 배치 처리
2. **Match Engine Layer**: 초당 200,000 주문, 10ms 미만 레이턴시
3. **Hybrid Liquidity Layer**: 70개 이상 체인 크로스체인 상호운용
4. **User Interface Layer**: 통합 UI

**실행 최적화:**
- edgeVM (perp 전용 VM) + edgeEVM (일반 DeFi)
- 병렬 트랜잭션 실행 (Deterministic PTE)
- FlashLane QoS: Fast Lane (주문) vs Slow Lane (출금)

### 2.6 Vertex Protocol (Arbitrum L2 하이브리드)

오프체인 시퀀서 + 온체인 risk engine 하이브리드 모델.

**특징:**
- 5~15ms 주문 처리 (CEX급 레이턴시)
- Spot + Perp + Money Market 통합 크로스 마진
- Vertex Edge: 5개 체인에 걸친 통합 오더북 유동성
- Elixir Protocol과 파트너십으로 AMM 유동성 통합

### 2.7 Orderly Network (OP Stack L2)

Off-chain 매칭 + On-chain 결제 분리 아키텍처.

**3-레이어 구조:**
```
Asset Layer     → 사용자 입출금 (다중 체인)
Settlement Layer → Orderly L2 (OP Stack) - 거래 원장
Engine Layer    → 오프체인 매칭 엔진 + 리스크 관리
```

**특징:**
- LayerZero로 크로스레이어 통신
- 단일 공유 오더북으로 체인 간 유동성 통합
- 오프체인 실행 → MEV 저항성
- 브로커/빌더 맞춤형 수수료 구조

---

## 3. 주문 유형 (Order Types)

### 3.1 주문 유형 전체 비교

| 주문 유형 | dYdX v4 | Lighter | Hyperliquid | Paradex | EdgeX | Vertex | Orderly |
|----------|---------|---------|-------------|---------|-------|--------|---------|
| Market | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Limit (GTC) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| IOC | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FOK | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ (SL/TP) | ✅ |
| Post-Only | ✅ | ✅ | ✅ (ALO) | ✅ | ✅ | ✅ | ✅ |
| Reduce-Only | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GTT | ✅ (GoodTilBlockTime) | ✅ | ❌ | ✅ | ✅ (4주) | 미기재 | 미기재 |
| Stop-Loss | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 미기재 |
| Take-Profit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 미기재 |
| TWAP | ✅ (v9.0+) | ✅ (30초) | ✅ (30초) | ✅ | 미기재 | 미기재 | 미기재 |
| Scale | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |

### 3.2 dYdX v4 — 주문 타입 상세

프로토콜 정의 (`proto/dydxprotocol/clob/order.proto`):

```protobuf
message Order {
  OrderId order_id = 1;
  Side side = 2;           // BUY, SELL
  uint64 quantums = 3;     // 기본 수량 (base amount)
  uint64 subticks = 4;     // 가격 (price level)
  bool reduce_only = 5;

  oneof good_til_oneof {
    uint32 good_til_block = 6;           // 단기 주문: 블록 번호 만료
    fixed32 good_til_block_time = 7;     // 장기 주문: Unix timestamp (초)
  }

  TimeInForce time_in_force = 8;
  uint32 client_id = 11;
  uint32 order_flags = 6;  // SHORT_TERM=0, LONG_TERM=64, CONDITIONAL=32, TWAP=128

  // 조건부 주문 전용
  OrderConditionType order_condition_type = 10;  // TAKE_PROFIT, STOP_LOSS
  uint64 conditional_order_trigger_subticks = 9;

  // TWAP 주문 전용
  TwapParameters twap_parameters = 12;
}

enum TimeInForce {
  TIME_IN_FORCE_UNSPECIFIED = 0;
  TIME_IN_FORCE_IOC = 1;
  TIME_IN_FORCE_POST_ONLY = 2;
  TIME_IN_FORCE_FILL_OR_KILL = 3;
}
```

**주문 플래그 분류:**
- **SHORT_TERM (0)**: 인메모리 주문, 최대 20블록 (~30초) 유효. GoodTilBlock 사용
- **LONG_TERM (64)**: 온체인 보관, GoodTilBlockTime으로 장기 유효. API 트레이더 비권장
- **CONDITIONAL (32)**: 오라클 가격 조건 충족 시 실행 (Stop, Take Profit)
- **TWAP (128)**: v9.0 추가, 타임슬라이스 실행

### 3.3 Hyperliquid — 주문 타입 상세

```json
// 주문 배치 요청 예시
{
  "action": {
    "type": "order",
    "orders": [{
      "a": 0,        // asset index
      "b": true,     // isBuy
      "p": "35000",  // price
      "s": "0.1",    // size
      "r": false,    // reduceOnly
      "t": {
        "limit": {
          "tif": "Gtc"   // "Gtc" | "Ioc" | "Alo" (post-only)
        }
      },
      "c": "0x1234..."  // cloid (선택적 128-bit hex)
    }]
  },
  "nonce": 1700000000000,
  "signature": {...}
}
```

**특수 주문:**
- **TWAP**: `minutes` (기간) + `randomize` (무작위 실행 타이밍) 파라미터. 30초 간격 슬라이스, 최대 슬라이스 크기 = 정상 크기의 3배
- **Scale Order**: 가격 범위 내 복수 리밋 주문 분산 배치
- **Dead Man's Switch (Schedule Cancel)**: 미래 타임스탬프 지정, 최소 5초 후, 하루 10회 제한

### 3.4 Orderly Network — 주문 파라미터

```json
POST /v1/order
{
  "symbol": "PERP_ETH_USDC",
  "order_type": "LIMIT",      // MARKET | LIMIT | IOC | FOK | POST_ONLY | REDUCE_ONLY
  "side": "BUY",              // BUY | SELL
  "order_price": 3500.00,
  "order_quantity": 1.5,
  "client_order_id": "my-order-001",
  "visible_quantity": 1.0     // Iceberg 주문 지원
}
```

**주문 실행 규칙:**
- **IOC**: 지정가에서 가능한 최대량 체결, 잔량 취소
- **FOK**: 전량 즉시 체결 불가 시 전체 취소
- **POST_ONLY**: 즉시 메이커 체결 시 전체 취소
- **REDUCE_ONLY**: 현재 포지션만 축소, 새 포지션 오픈 불가

### 3.5 EdgeX — 주문 타입 상세

```
Limit Order:
  - FOK (Fill-or-Kill): 즉시 전량 체결 or 취소
  - GTT (Good-Till-Time): 최대 4주 유효
  - IOC: 즉시 가능 수량 체결, 잔량 취소
  - Post-Only: 메이커로만 등록
  - Reduce-Only: 포지션 축소만

Market Order:
  - 최우선 가격으로 즉시 체결

Conditional Order:
  - Conditional Market: 트리거 가격 도달 시 시장가 실행
  - Conditional Limit: 트리거 가격 도달 시 지정가 실행
```

### 3.6 Lighter — 주문 타입 상세

```
Market Order:      즉시 최우선 가격 체결
Limit Order:       지정가 또는 더 유리한 가격 체결
Post-Only:         메이커로만 등록 (크로스 시 취소)
Reduce-Only:       포지션 크기를 0을 향해 축소
IOC:               즉시 체결 후 잔량 취소 (북에 등록 불가)
GTT:               만료 시간까지 유효
Stop-Loss (Market/Limit): 트리거 → 시장가/지정가
Take-Profit (Market/Limit): 트리거 → 시장가/지정가
TWAP:             30초 간격 슬라이스, Reduce-Only 옵션 지원
```

---

## 4. 매칭 엔진 (Matching Engine)

### 4.1 공통 원칙: Price-Time Priority

모든 DEX가 Price-Time Priority(가격-시간 우선순위)를 사용:
1. **Price**: 더 유리한 가격의 주문이 먼저 체결
2. **Time**: 같은 가격 레벨에서는 먼저 등록된 주문이 먼저 체결

### 4.2 dYdX v4 — MemClobPriceTimePriority

**데이터 구조** (`protocol/x/clob/memclob/memclob.go`):

```go
type MemClobPriceTimePriority struct {
  // ClobPairId → Orderbook 매핑
  orderbooks map[ClobPairId]*Orderbook
}

type Orderbook struct {
  // 가격 레벨 맵 (bid/ask)
  Bids map[Subticks]*Level
  Asks map[Subticks]*Level

  // 주문 ID → 레벨 주문 매핑
  OrderIdToLevelOrder map[OrderId]*LevelOrder

  // 서브계정별 주문 추적
  SubaccountOrders map[SubaccountId]map[OrderId]bool

  // 만료 추적
  BlockExpirationOrders map[uint32][]OrderId
}
```

**매칭 알고리즘:**

```
1. 검증 단계:
   - 취소 상태 확인
   - 교체(replacement) 유효성 검증
   - 잔여 수량 충분 여부 확인

2. 매칭 단계:
   - 테이커 매수 → 최우선 ask 레벨부터 스캔
   - 테이커 매도 → 최우선 bid 레벨부터 스캔
   - 가격 오버랩이 없을 때까지 반복

3. 상태 업데이트 단계:
   - 체결된 메이커 주문 fillAmount 업데이트
   - 완전 체결 시 주문 제거
   - 매치 오퍼레이션 큐 기록 (블록 제안용)

4. 잔량 처리:
   - IOC: 잔량 취소
   - GTC: 오더북에 등록 (잔량 > 0이고 IOC 아닌 경우)
```

**낙관적 실행 모델**: fill 정보를 즉시 상태에 기록 → 빠른 블록 생성 가능

### 4.3 Lighter — Order Book Tree

```
Order Book Tree = Merkle Tree + Prefix Tree 하이브리드

리프 인덱스 인코딩: (price << 32) | nonce
- 삽입: Θ(log N)
- 삭제: Θ(log N)
- 최우선 호가 조회: Θ(log N)
- 가격 범위 조회: Θ(log N + k) (k = 결과 수)

ZK Circuit 강제 규칙:
- Price-time priority 준수
- 청산 규칙 준수
- Ethereum에서 zk-proof 검증
```

### 4.4 Vertex Protocol — Off-chain Sequencer

```
흐름:
1. 사용자가 오프체인 시퀀서에 주문 전송
2. 시퀀서가 AMM 가격과 오더북 가격 비교
3. 최우선 가격 선택하여 체결
4. On-chain Risk Engine에서 실시간 검증
5. 결과 Arbitrum 온체인 기록

레이턴시: 5~15ms (CEX 수준)
```

### 4.5 Orderly Network — Off-chain + On-chain Settlement

```
흐름:
1. 주문 → 오프체인 엔진에 도달
2. 오프체인 매칭 (MEV 방지 - 프런트런 불가)
3. 체결 결과 → Orderly L2 Settlement Layer 기록
4. L2 → Ethereum L1 최종 결제 (주기적)

특징:
- 단일 공유 오더북 (멀티체인 유동성 통합)
- LayerZero 크로스레이어 통신
```

---

## 5. 자기 거래 방지 (STP)

### 5.1 STP 비교

| DEX | STP 지원 | 모드 | 기본값 |
|-----|---------|------|--------|
| dYdX v4 | 미기재 (동일 subaccount 제한) | - | - |
| Lighter | ✅ | 메이커 취소 | 메이커 취소 |
| Hyperliquid | ✅ (암묵적) | 미기재 | - |
| Paradex | ✅ | Expire Maker / Expire Taker / Expire Both | Expire Taker |
| EdgeX | 미기재 | - | - |
| Vertex | 미기재 | - | - |
| Orderly | 미기재 | - | - |

### 5.2 Paradex STP 상세

```
STP 트리거 조건: 동일 계정의 주문이 서로 매칭될 경우

모드:
1. EXPIRE_MAKER (REST 메이커 취소):
   - 오더북에 등록된 기존 주문(메이커) 취소
   - 새 테이커 주문 체결 진행

2. EXPIRE_TAKER (기본값 — 테이커 취소):
   - 새로 들어온 공격적 주문(테이커) 취소
   - 기존 메이커 주문 유지

3. EXPIRE_BOTH (양방향 취소):
   - 메이커와 테이커 주문 모두 취소

API 파라미터 예시:
POST /v1/orders
{
  "stp": "EXPIRE_TAKER"  // EXPIRE_MAKER | EXPIRE_TAKER | EXPIRE_BOTH
}
```

### 5.3 Lighter STP 상세

```
STP 동작: 자기 매칭 감지 시 항상 메이커 측 취소

이유: 테이커가 새로운 의도를 가진 주문이므로
      기존 메이커를 취소하는 것이 의미론적으로 올바름
      (불필요한 수수료와 포지션 변동 방지)
```

### 5.4 dYdX v4 STP 아키텍처 노트

dYdX v4는 동일 서브계정 내 중복 clientId를 허용하지 않는다. 이는 완전한 STP는 아니지만, 동일 서브계정이 동일 clientId로 중복 주문을 내는 것을 방지한다. 크로스-서브계정 자기 거래는 프로토콜 레벨에서 명시적 STP 없이 허용될 수 있다.

### 5.5 HyperKRW 권장 STP 구현

```python
# 의사코드: STP 구현 패턴
def match_order(taker_order, order_book):
    for maker_order in order_book.get_matching_orders(taker_order):
        if taker_order.account_id == maker_order.account_id:
            stp_mode = taker_order.stp_mode or "EXPIRE_TAKER"

            if stp_mode == "EXPIRE_TAKER":
                cancel_order(taker_order)
                return  # 매칭 중단
            elif stp_mode == "EXPIRE_MAKER":
                cancel_order(maker_order)
                continue  # 다음 메이커와 매칭 시도
            elif stp_mode == "EXPIRE_BOTH":
                cancel_order(taker_order)
                cancel_order(maker_order)
                return

        execute_fill(taker_order, maker_order)
```

---

## 6. 펀딩 레이트 (Funding Rate)

### 6.1 펀딩 레이트 공식 비교

| DEX | 공식 | 샘플링 | 결제 주기 | 이자율 | 캡 |
|-----|------|--------|----------|--------|-----|
| dYdX v4 | Premium/8 + Interest | 1분 (60개 샘플 평균) | 1시간 | 0% | 600% × (IMF - MMF) |
| Lighter | hourly_avg_premium/8 + interest | 1분 (60개 샘플 TWAP) | 1시간 | 시장별 고정 | ±0.5%/시간 |
| Hyperliquid | P + clamp(interest - P, -0.05%, 0.05%) | 5초 (시간 평균) | 1시간 | 0.01%/8h | 4%/시간 |
| Paradex | Funding Multiplier × (Fair Basis + clamp(Interest, Fair Basis, Clamp Rate)) | 5초 (연속 적립) | 연속 (포지션 변경 시 정산) | 0.01% | ±5% |
| EdgeX | P + clamp(I - P, -0.05%, 0.05%) | 1분 TWAP | 1시간 | 시장별 | 미기재 |
| Vertex | (mTwap - iTwap) / 3600 | 1시간 TWAP | 1시간 | 0 | 10%/일 |
| Orderly | clamp[FundingFunc(AvgPremium) + clamp(IR - AvgPremium, cap_ir, floor_ir) / (8/N)] | 15초 (1,920개/8h) | 1h/4h/8h 가변 | 0.01% | 시장별 |

### 6.2 dYdX v4 펀딩 레이트

**공식:**
```
Funding Rate = (Premium Component / 8) + Interest Rate Component

Premium Component:
  Premium = (Max(0, Impact Bid Price - Index Price)
           - Max(0, Index Price - Impact Ask Price))
           / Index Price

Impact Bid/Ask Price:
  = 영향 명목 금액에 대한 시장가 평균 실행 가격
  영향 명목 금액 = 500 USDC / Initial Margin Fraction

Interest Rate:
  기본값 0% (거버넌스로 변경 가능)
  일부 isolated market: 0.125 bps/시간

샘플링:
  - Funding-Sample Epoch: 1분마다 validators가 premium vote 제출
  - 1분 말에 중앙값(median) premium 계산
  - Funding-Tick Epoch: 1시간마다 60개 샘플 단순 평균

펀딩 레이트 캡:
  8h cap = 600% × (Initial Margin Fraction - Maintenance Margin Fraction)
  예: BTC (IMF=5%, MMF=3%) → 8h cap = 600% × 2% = 12%

결제:
  Funding Amount = Position Size × Oracle Price × Hourly Funding Rate
  long > short: long 지불 → short 수취
  long < short: short 지불 → long 수취
```

### 6.3 Hyperliquid 펀딩 레이트

```
Funding Rate (F) = Average Premium Index (P)
                 + clamp(interest_rate - P, -0.0005, 0.0005)

Premium Index:
  premium = impact_price_difference / oracle_price

  impact_price_difference = max(impact_bid_px - oracle_px, 0)
                          - max(oracle_px - impact_ask_px, 0)

샘플링: 5초마다 premium 샘플 → 1시간 평균

이자율: 0.01% per 8h = 0.00125%/h (short에게 지급)

결제:
  Funding Payment = position_size × oracle_price × hourly_funding_rate
  주의: 마크 가격이 아닌 오라클 가격으로 명목 계산

캡: ±4%/시간
```

### 6.4 Paradex 펀딩 레이트 (연속 펀딩)

```
Funding Rate = capped(
  Funding_Multiplier × (Fair_Basis + clamp(Interest_Rate, Fair_Basis, Clamp_Rate))
)

파라미터:
  Interest Rate:        0.01%
  Clamp Rate:          0.05%
  Maximum Funding Rate: ±5%
  Funding Multiplier:   1.0 (기본); 0.5 (RWA 시장)

Funding Premium (8h 지급 금액):
  Funding Premium = Funding Rate × (Spot Oracle Price / USDC Oracle Price)
  단위: USDC

특이점:
  - 5초마다 mark price와 함께 업데이트
  - 연속 적립: 미실현 펀딩 PnL이 즉시 계정 가치에 반영
  - 포지션 변경 시 정산 (온체인 확정)
```

### 6.5 Vertex Protocol 펀딩 레이트

```
fundingRate(t) = (mTwap(t) - iTwap(t)) / (60 × 60)

여기서:
  mTwap(t) = t 시간 종료 시점의 마크 가격 TWAP (1시간)
  iTwap(t) = t 시간 종료 시점의 인덱스/오라클 가격 TWAP (1시간)

오라클: 주로 Stork (초저레이턴시 하이브리드 오라클 네트워크)

캡: ±10%/일

결제:
  Funding Payment = position_size × cumulative_funding_rate_change
  매 1시간마다 결제
```

### 6.6 Orderly Network 펀딩 레이트

```
Funding Rate = clamp[
  FundingFunction(Average_Premium)
  + clamp(Interest_Rate - Average_Premium, cap_ir, floor_ir) / (8/N),
  Cap_Funding,
  Floor_Funding
]

여기서:
  N = 1 (8시간 주기), 2 (4시간), 8 (1시간)
  Interest_Rate = 0.01% (고정)

Premium 계산:
  - 8시간 동안 15초마다 1회 = 1,920개 샘플
  - Average_Premium = 8시간 샘플 평균

결제 주기:
  - BTC/ETH 등 주요 자산: 8시간
  - 기타 자산: 8시간 (시장 상황에 따라 1h/4h 변경 가능)

결제 시점:
  - 매 8시간 (또는 설정된 주기)에 펀딩비 계산
  - PnL 정산 호출 시 정산
```

### 6.7 Lighter 펀딩 레이트

```
Funding Rate ≈ hourly_avg_premium / 8 + interest_rate_component

Premium:
  mark_price - index_price
  1분마다 샘플, 60개 샘플 1시간 TWAP 계산

이자율 컴포넌트:
  base/quote 통화 금리 차이 반영 (시장별 고정)

캡: ±0.5%/시간

결제:
  완전 피어-투-피어 (거래소 수수료 없음)
  매 1시간 결제
```

### 6.8 HyperKRW 권장 펀딩 레이트 구현

HyperKRW는 KRW 기반 perp이므로 다음 설계를 권장:

```python
# 펀딩 레이트 계산 의사코드
def calculate_funding_rate(market, current_hour):
    """
    dYdX v4 방식 기반, 1시간 결제
    """
    # 1. Premium 샘플 수집 (1분마다)
    premiums = []
    for minute in range(60):
        impact_bid = get_impact_bid_price(market, IMPACT_NOTIONAL)
        impact_ask = get_impact_ask_price(market, IMPACT_NOTIONAL)
        index_price = get_oracle_price(market)

        premium = (
            max(0, impact_bid - index_price)
            - max(0, index_price - impact_ask)
        ) / index_price
        premiums.append(premium)

    # 2. 1시간 평균 프리미엄
    avg_premium = sum(premiums) / len(premiums)

    # 3. 펀딩 레이트 계산
    interest_rate = INTEREST_RATE_PER_8H / 8  # hourly
    funding_rate_8h = avg_premium + clamp(
        interest_rate - avg_premium,
        -0.0005, 0.0005
    )

    # 4. 캡 적용
    cap = 6.0 * (IMF - MMF)  # 600% × (IMF - MMF)
    funding_rate_8h = clamp(funding_rate_8h, -cap, cap)

    # 5. 시간당 비율로 변환
    hourly_rate = funding_rate_8h / 8

    return hourly_rate

def settle_funding(position, hourly_rate, oracle_price):
    """결제 금액 계산"""
    # 마크 가격이 아닌 오라클 가격 사용 (Hyperliquid 방식)
    payment = position.size * oracle_price * hourly_rate

    if position.side == "LONG":
        position.account.balance -= payment  # long이 지불
    else:
        position.account.balance += payment  # short이 수취
```

---

## 7. 오라클/마크 가격 (Oracle / Mark Price)

### 7.1 마크 가격 공식 비교

| DEX | 인덱스 가격 소스 | 마크 가격 공식 | 업데이트 주기 |
|-----|----------------|--------------|-------------|
| dYdX v4 | Slinky (validator consensus) | 인덱스 가격 (합의) | 매 블록 |
| Lighter | Stork 오라클 (primary) + Chainlink + Pyth | Median(P1, P2, Impact Price) | 실시간 |
| Hyperliquid | Weighted median of 8 CEX | Median(EMA-adjusted oracle, HL mid, CEX perp median) | ~3초 |
| Paradex | 스팟 오라클 | Fair Basis 기반 | 5초 |
| EdgeX | 미기재 | 미기재 | 미기재 |
| Vertex | Stork 오라클 | 1시간 TWAP | 실시간 |
| Orderly | Volume-weighted avg of major CEX | Clamp(Median(P1, P2, Futures Price), index±cap) | 연속 |

### 7.2 Hyperliquid 마크 가격 (가장 복잡한 공식)

```
Mark Price = Median(Component1, Component2, Component3)

Component1:
  oracle_price + EMA_150s(HL_mid - oracle_price)
  - 150초 반감기 EMA로 오라클과 HL 미드프라이스 스프레드의 지수이동평균
  - EMA 업데이트: exp(-elapsed / half_life) × old + (1 - exp(-..)) × new

Component2:
  Median(HL best bid, HL best ask, HL last trade)
  - Hyperliquid 오더북 내부 데이터

Component3:
  Weighted median of (Binance perp, OKX perp, Bybit perp, Gate perp, MEXC perp)
  가중치: Binance=3, OKX=2, Bybit=2, Gate=1, MEXC=1

용도: 마진 계산, 청산 트리거, TP/SL 트리거, 미실현 PnL 계산

오라클 인덱스 가격:
  Weighted median of (Binance spot, OKX spot, Bybit spot, Kraken spot,
                      Kucoin spot, Gate spot, MEXC spot, HL spot)
  가중치: 3, 2, 2, 1, 1, 1, 1, 1 (총 12)
  업데이트: 약 3초마다 (validators 게시)
```

### 7.3 Orderly Network 마크 가격

```
인덱스 가격:
  Index = Volume-Weighted Average Price of major spot CEXs
  가중치 = CEX_i 거래량 / 총 거래량 (4시간 거래량 기반, 5분마다 업데이트)
  이상값 처리: 중앙값 대비 ±5% 초과 소스는 ±5%로 클리핑
              10초 이상 데이터 없는 소스는 제외

마크 가격 (2단계 계산):
  Step 1 - Median Price 계산:
    P1 = Index × (1 + Last_Funding_Rate × remaining_time / 8h)
    P2 = Index + MA_15min(Basis)
         여기서 Basis = Median(Bid0, Ask0) - Index (1분마다 스냅샷)
    FuturesPrice = Median(Bid0, Ask0, Last_Price)
    MedianPrice = Median(P1, P2, FuturesPrice)

  Step 2 - 편차 제한 적용:
    Mark = Clamp(
      MedianPrice,
      Index × (1 + Factor × Cap_Funding),    // 상한
      Index × (1 + Factor × Floor_Funding)   // 하한
    )
    BTC/ETH: ±3%, others: ±5.25%
```

### 7.4 dYdX v4 오라클 메커니즘

```
Slinky 모듈 사용:
1. 매 블록 Precommit 단계에서 모든 validators가
   vote extension으로 오라클 가격 제출
2. 다음 블록에서 Slinky가 이전 블록의 모든 VE를 집계
3. 결정론적으로 새 가격 제안 → 합의로 확정

가격 수용 기준:
  - 이전 가격 대비 급격한 변동 방지
  - validators들이 "합리적 범위" 내 가격만 수용

마크 가격 = 합의된 오라클 가격 (별도 spot premium 없음)
            (funding premium은 Impact Bid/Ask로 계산)
```

### 7.5 HyperKRW 마크 가격 권장 설계

KRW 시장이므로 국내 거래소를 주요 소스로 활용:

```python
def calculate_krw_index_price():
    """
    KRW 기반 자산의 인덱스 가격 계산
    """
    # 1. 국내외 주요 거래소 가격 수집
    sources = {
        "upbit_krw": get_price("upbit", "KRW"),
        "bithumb_krw": get_price("bithumb", "KRW"),
        "binance_usdt": get_price("binance", "USDT") * get_usd_krw_rate(),
        "okx_usdt": get_price("okx", "USDT") * get_usd_krw_rate(),
    }

    # 2. 이상값 필터링 (중앙값 ±5% 초과 제외)
    median_price = statistics.median(sources.values())
    filtered = {k: v for k, v in sources.items()
                if abs(v - median_price) / median_price <= 0.05}

    # 3. 거래량 가중 평균
    volumes = get_volumes(filtered.keys())
    total_volume = sum(volumes.values())
    index_price = sum(
        price * volumes[exchange] / total_volume
        for exchange, price in filtered.items()
    )

    return index_price

def calculate_mark_price(index_price, order_book, last_funding_rate, time_to_funding):
    """Orderly 방식 마크 가격"""
    P1 = index_price * (1 + last_funding_rate * time_to_funding / FUNDING_PERIOD)

    basis_ma = get_15min_ma_basis(order_book, index_price)
    P2 = index_price + basis_ma

    futures_price = statistics.median([
        order_book.best_bid,
        order_book.best_ask,
        order_book.last_price
    ])

    median_price = statistics.median([P1, P2, futures_price])

    # 편차 제한 (±3%)
    mark_price = max(
        index_price * 0.97,
        min(index_price * 1.03, median_price)
    )

    return mark_price
```

---

## 8. 청산 엔진 (Liquidation Engine)

### 8.1 청산 메커니즘 비교

| DEX | 청산 트리거 | 청산 방식 | 보험 펀드 | ADL | 청산 수수료 |
|-----|-----------|---------|---------|-----|-----------|
| dYdX v4 | Total Value < Maintenance Margin | 오더북 매칭 (Fillable Price) | 보험 펀드 (손익 흡수) | ✅ | 최대 1.5% (보험 펀드) |
| Lighter | Mark Price < Liquidation Price | 오더북 + Public Pool (보험 펀드) | Insurance Fund Pool | ❌ (미기재) | 미기재 |
| Hyperliquid | Equity < Maintenance Margin | 오더북 시장가 → HLP Vault Backstop | HLP (커뮤니티 vault) | ✅ (2025.10 최초 발동) | 0 (잔여 마진 보존) |
| Paradex | Margin Ratio > 100% | 파셜 청산 (20% 단위) | Insurance Fund | ✅ (Socialized Loss) | 70% MMR 연계 페널티 |
| EdgeX | 계정별 독립 청산 | 계정별 독립 처리 | 미기재 | 미기재 | 미기재 |
| Vertex | Margin Requirement 미충족 | 즉시 청산 | Insurance Fund (스테이킹 수익) | 미기재 | 미기재 |
| Orderly | AMR < MMR | 포지션 이전 (할인 청산) | Insurance Fund + 청산자 | ✅ (ADL) | BTC/ETH/SOL: 0.6%, 기타: 1.2% |

### 8.2 dYdX v4 청산 상세

**청산 가격 공식:**

```
Isolated Position:
  p' = (e - s × p) / (|s| × MMF - s)

Cross-Margined Position:
  p' = (e - s × p - MMR_o) / (|s| × MMF - s)

여기서:
  e   = equity (계정 자산)
  s   = position size (양수=롱, 음수=숏)
  p   = entry price
  MMF = Maintenance Margin Fraction
  MMR_o = 다른 포지션의 유지 마진 요구량
```

**청산 프로세스:**
```
1. 감지: Total Account Value < Maintenance Margin Requirement
2. 실행: 프로토콜이 "Fillable Price"를 리밋 가격으로 하는 청산 주문 생성
         오더북 유동성과 매칭
3. 완료: 서브계정 포지션 부분 또는 전체 청산
4. 페널티: 최대 1.5% (보험 펀드로 이전)
5. 처리: 청산 손익 → 보험 펀드에서 흡수
         자본이 음수 시 ADL 발동

Fillable Price 계산:
  Max spread from oracle = 1.5 × MMF = 4.5% (기본값)
  파산 등급에 따라 스프레드 증가
```

### 8.3 Hyperliquid 청산 상세

**유지 마진 계산:**
```
유지 마진율 = max_leverage 기준 초기 마진율의 절반
예: max 20x → 유지마진율 = (1/20) / 2 = 2.5%

청산 가격:
  liq_price = price - side × margin_available / position_size / (1 - l × side)

  Cross: 레버리지 무관 (공유 마진)
  Isolated: 레버리지 의존 (초기 마진으로 설정)
```

**2단계 청산:**
```
1단계 - 오더북 청산:
  - 청산 주문을 오더북에 시장가로 전송
  - 모든 사용자가 청산 플로우 경쟁 가능
  - 포지션이 완전/부분 청산되면 잔여 마진 트레이더 반환
  - 포지션 > $100k: 한 번에 20%씩 청산, 30초 쿨다운

2단계 - Backstop 청산 (HLP Vault):
  - Equity < 유지마진의 2/3일 때 발동
  - HLP(Hyperliquid Protocol Vault) Vault가 포지션 인수
  - 유지 마진은 트레이더에게 반환되지 않음
  - 청산 수익은 커뮤니티 HLP로 분배

ADL (Auto-Deleveraging):
  - 보험 펀드(HLP)가 손실 흡수 불가 시 발동
  - 고레버리지 고수익 포지션의 일부를 강제 감소
  - 2025.10.10 최초 발동 (10분 내 40건 이상)
```

### 8.4 Paradex 청산 상세

```
트리거: Margin Ratio > 100%
  Margin Ratio = Account_IMR / Account_Value × 100%

파셜 청산 방식:
  - 20% 단위로 순차 청산
  - 청산 후 Margin Ratio 목표: 정상 범위 복귀
  - 플랫폼 리스크 최소화 목표

청산 수수료:
  - 70% MMR 연계 페널티
  - 부분 청산의 유리한 실행 금액의 최대 1% → 보험 펀드

Socialized Loss (사회화 손실):
  - 보험 펀드 고갈 시 최후 수단
  - 출금 시 Socialized Loss Factor 적용 (결손 보전)
  - 플랫폼 지불 능력 회복 시까지 출금에 적용
```

### 8.5 Orderly Network 청산 상세

```
트리거: AMR (Account Margin Ratio) < MMR (Maintenance Margin Ratio)

청산 프로세스:
  1. 모든 미체결 주문 취소
  2. USDC 잔액 동결
  3. AMR을 Initial Margin Ratio로 복구하는 최소 포지션 계산
  4. 포지션을 할인된 가격에 청산자에게 이전 (오더북 아님)

분산 청산자 모델:
  - 누구나 Orderly 계정 보유 시 청산자 참여 가능
  - 할인된 가격에 포지션 인수

수수료 분배:
  시장별 총 청산 수수료:
    BTC/ETH/SOL: 0.60% (청산자 0.30% + 보험 펀드 0.30%)
    기타: 1.20% (청산자 0.60% + 보험 펀드 0.60%)

  마진 상태에 따른 분배:
    마진 충분: 보험 펀드 0.5× + 청산자 0.5× (각각)
    마진 부족: 청산자 0.5×, 나머지 보험 펀드
    임계치 미달: 전액 보험 펀드

ADL 발동 조건:
  - 일정 기간 내 보험 펀드 x% 감소
  - AMR이 MMR 미만 지속
```

### 8.6 HyperKRW 권장 청산 구현

```python
def check_liquidation(account, markets):
    """청산 조건 확인"""
    total_equity = account.balance + sum(
        position.unrealized_pnl for position in account.positions
    )
    total_maintenance_margin = sum(
        abs(position.size) * mark_price(position.market) * MMF[position.market]
        for position in account.positions
    )

    if total_equity < total_maintenance_margin:
        trigger_liquidation(account)

def trigger_liquidation(account):
    """청산 실행"""
    # 1. 모든 미체결 주문 취소
    cancel_all_open_orders(account)

    # 2. 포지션 규모에 따른 청산 방식 결정
    for position in sorted(account.positions, key=lambda p: abs(p.notional), reverse=True):
        if abs(position.notional) > LARGE_POSITION_THRESHOLD:  # $100k
            # 대형 포지션: 20% 단위 청산
            liquidate_partial(position, fraction=0.20)
        else:
            # 소형 포지션: 전체 청산 시도
            liquidate_full(position)

    # 3. 청산 후 계정 건강도 재확인
    if is_healthy(account):
        return  # 청산 완료

    # 4. 오더북 청산 실패 시 보험 펀드 사용
    insurance_fund.absorb_loss(account.deficit)

def calculate_liquidation_price(position, account_equity, other_mmr=0):
    """청산 가격 계산 (dYdX v4 공식)"""
    e = account_equity
    s = position.size  # 롱: 양수, 숏: 음수
    p = position.entry_price
    MMF = MAINTENANCE_MARGIN_FRACTION[position.market]

    # Cross-margin 청산 가격
    liq_price = (e - s * p - other_mmr) / (abs(s) * MMF - s)
    return liq_price
```

---

## 9. 마진 시스템 (Margin System)

### 9.1 마진 시스템 비교

| DEX | 기본 마진 | 최대 레버리지 | IMF | MMF | 포트폴리오 마진 |
|-----|---------|------------|-----|-----|--------------|
| dYdX v4 | 크로스 (서브계정별) | 시장별 (BTC ~20x) | 5% (대형) | 3% (대형) | ❌ |
| Lighter | 크로스/아이솔레이티드 | BTC/ETH 50x | 2% (BTC/ETH) | 1.2% | ❌ |
| Hyperliquid | 크로스 (기본) | 자산별 | max_lev 기반 | IMF/2 | ✅ (HIP-3) |
| Paradex | 크로스 (포트폴리오) | 시장별 | IMF | MMF (= IMF × 50%) | ✅ |
| EdgeX | 크로스 (서브계정 분리) | 미기재 | 미기재 | 미기재 | ❌ |
| Vertex | 통합 크로스 (spot+perp+MM) | 시장별 | 시장별 | 미기재 | ✅ |
| Orderly | 크로스 | 시장별 | 시장별 | 시장별 | ❌ |

### 9.2 dYdX v4 마진 상세

```
IMF (Initial Margin Fraction):
  - 기본값 (고정 구간): 시장별 고정
  - 동적 구간 (open interest 기반):
    effective_IMF = Min(base_IMF + Max(IMF_increase, 0), 100%)

    IMF_increase는 open_notional_lower_cap ~ upper_cap 사이에서
    선형으로 증가

마진 요구량:
  Initial Margin = |S × P × IMF|   (새 포지션 오픈 시)
  Maintenance Margin = |S × P × MMF|  (포지션 유지 시)

  여기서 S = size, P = oracle price

Free Collateral (가용 자산):
  = Total Account Value - Total Initial Margin Requirement

서브계정 구조:
  - 각 주소당 최대 128개 서브계정 (number: 0~127)
  - 서브계정 간 독립적인 마진
  - 같은 서브계정 내 모든 포지션이 크로스 마진 공유
```

### 9.3 Hyperliquid 마진 상세

```
마진 종류:
  1. Cross Margin (기본):
     - 모든 크로스 포지션이 담보 공유
     - 미실현 PnL이 자동으로 다른 포지션의 마진으로 활용

  2. Isolated Margin:
     - 단일 자산에 마진 한정
     - 한 포지션의 청산이 다른 포지션에 영향 없음
     - 포지션 오픈 후 마진 추가/제거 가능

  3. Strict Isolated:
     - Isolated와 동일, 단 마진 제거 불가
     - 포지션 청산 비례로만 마진 감소

마진 계산:
  Required Margin = position_size × mark_price / leverage

  초기 마진율 = 1 / max_leverage (자산별)
  유지 마진율 = (1 / max_leverage) / 2

출금 제한:
  미실현 PnL 출금 시:
    포지션 명목 가치의 10% + 초기 마진 요구량 유지 필요

레버리지 설정:
  1x ~ max_leverage (정수)
  레버리지 한도는 포지션 오픈 시만 강제 적용
  이후 시장 움직임에 의한 초과는 사용자가 관리
```

### 9.4 Paradex 마진 계산 (가장 상세한 공개 문서)

```
Cross Margin Account Margin Requirement:
  Account_MR = Σ Margin_Requirement(market_m)

Initial Margin Requirement (IMR) 구성요소:
  1. Net IMR:
     Buy IMR  = max(0, Total_Buy_Orders + Signed_Position) × IMF × Mark_Price
     Sell IMR = max(0, Total_Sell_Orders - Signed_Position) × IMF × Mark_Price
     Market_Net_IMR = max(Buy_IMR, Sell_IMR)

     Open Size (Buy)  = max(0, Total_Buy_Orders + Signed_Position)
     Open Size (Sell) = max(0, Total_Sell_Orders - Signed_Position)

  2. Fee Provision:
     예상 진입/퇴출 수수료

  3. Open Loss:
     공격적 주문(테이커)에 대한 충당금

Maintenance Margin Requirement (MMR) 구성요소:
  1. Net MMR = Net_IMR × MMF_Factor (보통 50%)
     → MMF ≈ IMF × 0.5

  2. Fee Provision = Taker Fee × Position Value

레버리지 지표:
  Effective Leverage = Open Notional / Account Value
  Max Leverage = Open Notional / Account IMR

Portfolio Margin:
  상관관계를 고려한 포트폴리오 레벨 위험 평가로 마진 절감
```

### 9.5 Vertex 통합 크로스 마진

```
통합 크로스 마진 엔진:
  - Spot 포지션 + Perp 포지션 + Money Market 대출/예금
  - 모두 동일한 마진 풀에서 담보 공유

예시:
  - ETH Spot 보유 → BTC Perp 마진으로 활용
  - USDC 대출 예금 이자 → 다른 포지션 마진으로 사용
  - Spot 포지션의 미실현 수익 → Perp 추가 마진

Fee Structure와 마진:
  - 모든 수수료 USDC로 정산
  - 메이커 수수료: 0% (무료)
  - 테이커 수수료: 0.02%
```

---

## 10. API 설계 패턴

### 10.1 API 아키텍처 비교

| DEX | REST 패턴 | 인증 | WS 채널 | Rate Limit |
|-----|----------|------|--------|-----------|
| dYdX v4 | Indexer HTTP + Validator gRPC | STARK 서명 | 인덱서 WS | 시퀀스 번호 |
| Lighter | REST + WS | - | - | - |
| Hyperliquid | POST /info + POST /exchange | EVM 서명 (nonce) | WS subscriptions | 누적 거래량 기반 |
| Paradex | GET/POST /v1/ | JWT (StarkNet 서명) | WS subscriptions | 계정당 + IP당 |
| EdgeX | - | - | - | - |
| Vertex | Off-chain engine + Indexer | 서명 | WS | - |
| Orderly | REST /v1/ | ed25519 키 | WS /ws/private/ | 키 단위 |

### 10.2 Hyperliquid API (가장 잘 정의된 API)

**엔드포인트:**
```
Base URL: https://api.hyperliquid.xyz

읽기 (Info):
  POST /info    ← 모든 쿼리 요청은 이 단일 엔드포인트 사용

쓰기 (Exchange):
  POST /exchange ← 모든 쓰기 요청은 이 단일 엔드포인트 사용
```

**Info 엔드포인트 주요 타입:**
```json
// 오더북
{"type": "l2Book", "coin": "BTC"}

// 캔들
{"type": "candleSnapshot", "req": {"coin": "BTC", "interval": "1h", "startTime": 0, "endTime": 0}}

// 미체결 주문
{"type": "openOrders", "user": "0x..."}
{"type": "frontendOpenOrders", "user": "0x..."}  // 추가 메타데이터 포함

// 주문 상태 (OID 또는 CLOID로 조회)
{"type": "orderStatus", "user": "0x...", "oid": 12345}
{"type": "orderStatus", "user": "0x...", "oid": "0x1234..."}  // cloid

// 체결 내역
{"type": "userFills", "user": "0x...", "aggregateByTime": false}
{"type": "userFillsByTime", "user": "0x...", "startTime": 0, "endTime": 0}

// 펀딩 레이트
{"type": "fundingHistory", "coin": "BTC", "startTime": 0, "endTime": 0}

// 수수료
{"type": "userFees", "user": "0x..."}
```

**Exchange 엔드포인트 주요 액션:**
```json
// 주문 배치
{
  "action": {
    "type": "order",
    "orders": [{
      "a": 0,           // asset index
      "b": true,        // isBuy
      "p": "35000",     // price (trailing zeros 자동 제거)
      "s": "0.1",       // size
      "r": false,       // reduceOnly
      "t": {"limit": {"tif": "Gtc"}},  // Gtc | Ioc | Alo
      "c": "0x..."      // cloid (선택)
    }],
    "grouping": "na"    // na | normalTpsl | positionTpsl
  },
  "nonce": 1700000000000,  // 현재 시간 (ms)
  "signature": {"r": "0x...", "s": "0x...", "v": 28},
  "vaultAddress": "0x..."  // 서브계정/vault 지정 (선택)
}

// 주문 취소
{
  "action": {
    "type": "cancel",
    "cancels": [{"a": 0, "o": 12345}]
  }
}

// CLOID로 취소
{
  "action": {
    "type": "cancelByCloid",
    "cancels": [{"asset": 0, "cloid": "0x..."}]
  }
}

// 주문 수정
{
  "action": {
    "type": "batchModify",
    "modifies": [{
      "oid": 12345,
      "order": {"a": 0, "b": true, "p": "36000", "s": "0.1", "r": false, "t": {"limit": {"tif": "Gtc"}}}
    }]
  }
}

// TWAP 주문
{
  "action": {
    "type": "twapOrder",
    "twap": {"a": 0, "b": true, "s": "1.0", "r": false, "m": 10, "t": false}
    // m=minutes, t=randomize
  }
}

// Dead Man's Switch
{
  "action": {
    "type": "scheduleCancel",
    "time": 1700005000000  // 최소 5초 후 (null = 취소)
  }
}
```

**WebSocket:**
```json
// 연결: wss://api.hyperliquid.xyz/ws
// 구독 메시지 형식
{"method": "subscribe", "subscription": {"type": "l2Book", "coin": "BTC"}}
{"method": "subscribe", "subscription": {"type": "trades", "coin": "BTC"}}
{"method": "subscribe", "subscription": {"type": "candle", "coin": "BTC", "interval": "1m"}}
{"method": "subscribe", "subscription": {"type": "allMids"}}
{"method": "subscribe", "subscription": {"type": "userEvents", "user": "0x..."}}
{"method": "subscribe", "subscription": {"type": "userFills", "user": "0x..."}}
{"method": "subscribe", "subscription": {"type": "orderUpdates", "user": "0x..."}}
{"method": "subscribe", "subscription": {"type": "webData2", "user": "0x..."}}

// Rate Limit: IP당 1000 WS subscriptions
```

**Rate Limit:**
```
- 누적 거래량 기반: 1 USDC 거래 = 1 request 한도
- 신규 계정 초기 버퍼: 10,000 requests
- expiresAfter 만료된 취소는 5× rate limit 소모
```

### 10.3 Orderly Network API

**인증:**
```
알고리즘: ed25519 타원곡선
키 유형:
  - Read scope: 읽기 전용 API 접근
  - Trading scope: 주문 생성/취소 포함 모든 주문 API

키 만료: 최대 365일
```

**주요 엔드포인트:**
```
Base: https://api.orderly.org/v1/   (Mainnet)
      https://testnet-api.orderly.org/v1/  (Testnet)

주문:
  POST   /v1/order           # 주문 생성
  DELETE /v1/order           # 주문 취소
  PUT    /v1/order           # 주문 수정
  GET    /v1/order/:order_id # 주문 조회
  GET    /v1/orders          # 주문 목록

포지션:
  GET /v1/positions          # 포지션 조회

시장 데이터 (Public):
  GET /v1/public/info                         # 서버 정보
  GET /v1/public/futures                      # 선물 시장 목록
  GET /v1/public/futures/:symbol              # 특정 시장 정보
  GET /v1/public/futures/:symbol/orderbook    # 오더북
  GET /v1/public/market_trades/:symbol        # 최근 거래
  GET /v1/public/funding_rates/:symbol        # 펀딩 레이트 이력

계정:
  GET /v1/client/info        # 계정 정보
  GET /v1/asset/history      # 자산 이력
```

**심볼 형식:** `PERP_<ASSET>_USDC` (예: `PERP_ETH_USDC`, `PERP_BTC_USDC`)

**WebSocket:**
```
Private: wss://ws-private-evm.orderly.org/v2/ws/private/stream/{account_id}
Public:  wss://ws-evm.orderly.org/v2/ws/public/stream/{broker_id}
```

### 10.4 Paradex API

**인증:**
```
JWT (JSON Web Token)
생성 방법: StarkNet 키로 서명
Base URL: https://api.testnet.paradex.trade/v1/  (테스트넷)
          https://api.prod.paradex.trade/v1/     (메인넷)
```

**주요 엔드포인트:**
```
GET    /v1/markets               # 시장 목록
GET    /v1/markets/{market}/orderbook  # 오더북
GET    /v1/markets/{market}/trades     # 최근 거래

POST   /v1/orders                # 주문 생성
POST   /v1/batch-orders          # 배치 주문
GET    /v1/orders                # 미체결 주문
DELETE /v1/orders/{order_id}     # 주문 취소
DELETE /v1/orders                # 전체 취소 (market 파라미터)

GET    /v1/positions             # 포지션
GET    /v1/account               # 계정 정보
GET    /v1/account/funding       # 펀딩 이력
GET    /v1/account/liquidations  # 청산 이력
```

**Rate Limit:**
```
Private: 계정당 제한 + IP당 1,500 req/min (모든 계정 합산)
```

### 10.5 dYdX v4 API 아키텍처

```
두 가지 클라이언트:

1. Validator Client (온체인 주문):
   gRPC 연결 → 노드 직접 통신
   서명: STARK curve 서명
   Short-term order: GoodTilBlock = current_height + 3 (권장)

2. Indexer Client (데이터 조회):
   REST + WebSocket
   Base URL: https://indexer.dydx.trade/v4/

   GET /v4/orders/{orderId}
   GET /v4/orders?address=&subaccountNumber=&status=
   GET /v4/trades/perpetualMarket/{ticker}
   GET /v4/perpetualMarkets
   GET /v4/funding
```

---

## 11. 수수료 구조 (Fee Structure)

### 11.1 수수료 비교 테이블

| DEX | 메이커 수수료 | 테이커 수수료 | 티어링 기준 | 메이커 리베이트 | 특이사항 |
|-----|------------|------------|----------|--------------|---------|
| dYdX v4 | -1.1 bps | 3 bps (기본) | 30일 거래량 | 최대 -1.1 bps | 스테이킹 할인 |
| Lighter | 0% (표준) | 0% (표준) | - | 0 | 프리미엄: 메이커 0.002%, 테이커 0.02% |
| Hyperliquid | 0~ -3 bps | 4.5 bps (기본) | 14일 가중 거래량 | 최대 -3 bps (거래량 점유율 ≥3%) | HYPE 스테이킹 할인 최대 40% |
| Paradex | -0.5 bps | 0 (리테일) / 2 bps (API) | Trader Profile | 있음 | ZFP: 리테일 0수수료 |
| EdgeX | 미기재 | 미기재 | - | - | - |
| Vertex | 0% | 2 bps | - | 없음 | 모든 수수료 USDC |
| Orderly | 0 bps | 3 bps (기본) | 30일 거래량 (Spot/Perp 분리) | 없음 | 브로커가 추가 수수료 설정 가능 |

### 11.2 dYdX v4 수수료 상세

```
Maker Fee: -1.1 bps (= -0.011%) — 리베이트
Taker Fee:  3 bps  (= 0.03%)   — 기본

30일 거래량 티어:
  Volume < $1M:     Taker 3 bps
  Volume $1M~$5M:   Taker 2.5 bps
  Volume $5M~$25M:  Taker 2 bps
  Volume ≥$25M:     Taker 1 bps (etc.)

스테이킹 할인:
  DYDX 스테이킹(bonded) 보유량에 따라 추가 할인
  (거버넌스로 변경 가능)

수수료 계산:
  Fee = Trade Size (USDC) × Fee Rate
  음수 수수료(메이커 리베이트) = 지급받음
```

### 11.3 Hyperliquid 수수료 상세

```
Perp Tier 0 (기본):
  Taker: 0.045% (4.5 bps)
  Maker: 0.015% (1.5 bps)

14일 가중 거래량 티어:
  가중 거래량 = Perp 거래량 + 2× Spot 거래량

Maker 거래량 점유율 리베이트:
  ≥0.5%: -0.001% (-1 bps)
  ≥1.5%: -0.002% (-2 bps)
  ≥3.0%: -0.003% (-3 bps)

HYPE 스테이킹 할인:
  5%~40% 추가 할인 (스테이킹량 + 14일 거래량 기준)

Aligned Quote Asset:
  20% 낮은 테이커 수수료, 50% 나은 메이커 리베이트

HIP-3 Growth Mode (신규 시장):
  표준 taker 수수료의 90% 이상 인하 (0.045% → ~0.005%)
```

### 11.4 Orderly Network 수수료 상세

```
기본 (Orderly 기본):
  Maker: 0 bps (무료)
  Taker: 3 bps

분배 구조:
  - Orderly는 3 bps taker fee 전액 보유
  - 브로커/빌더는 3 bps 이상의 추가 수수료를 자체 결정
  - 브로커 수수료는 Orderly 기본 수수료와 별도로 설정

거래량 티어:
  Spot과 Futures 별도 30일 거래량 기준 티어 적용

브로커 수익 분배:
  브로커는 자체 수수료 수익의 100% 보유
  일별 리베이트로 수수료 지갑에 입금
```

### 11.5 Paradex 수수료 상세

```
Trader Profile에 따른 구분:

1. Zero Fee Perps (Retail UI 트레이더):
   - Maker: 0%
   - Taker: 0%
   - 적용: 100개 이상 perp 시장 (BTC, ETH 제외)
   - 시작: 2025년 9월 10일

2. API Standard (일반 API):
   - Maker: 0%
   - Taker: 0.02% (2 bps)

3. Professional Market Maker (RPI):
   - 리테일 주문 플로우와 매칭 시 0.5 bps 지불

4. API Taker가 Retail과 매칭 시:
   - 75% 할인 적용

기본 Fee (과거 데이터 기준):
  Perp Futures: Maker -0.005%, Taker 0.03%
```

### 11.6 Vertex Protocol 수수료 상세

```
Taker Fee: 0.02%~0.04% (거래 규모에 따라)
Maker Fee: 0% (무료)

모든 수수료: USDC로 정산

Maker Program:
  30일 기간 내 maker 거래량 > 0.25% 시
  비례 리베이트 수령 (Elixir Protocol 통해 분배)

참조:
  - 거래 수수료는 USDC로 Vertex Sequencer에 납부
  - 리베이트도 USDC로 직접 지급
```

---

## 12. Client Order ID / 중복 방지

### 12.1 Client Order ID 비교

| DEX | 필드명 | 형식 | 고유성 범위 | 용도 |
|-----|--------|------|-----------|------|
| dYdX v4 | `clientId` | uint32 | 서브계정 내 고유 | 주문 교체 (같은 ID = 교체) |
| Hyperliquid | `cloid` | 128-bit hex string | 계정 내 고유 | 조회/취소에 활용 |
| Orderly | `client_order_id` | string | 계정 내 | 중복 방지, 조회 |
| Paradex | `client_id` | string | 계정 내 | 중복 방지 |
| EdgeX | 미기재 | - | - | - |
| Vertex | 지원 (미상세) | - | - | - |
| Lighter | 미기재 | - | - | - |

### 12.2 dYdX v4 ClientId 및 멱등성 (Idempotency)

```
Order ID 구성:
  OrderId = SubaccountId + ClientId + ClobPairId + OrderFlags

중복 방지 규칙:
  - 같은 서브계정의 같은 clientId는 단 하나만 활성 가능
  - 동일 OrderId로 새 주문 배치 = 기존 주문 교체 (GoodTilBlock 더 큰 경우)

단기 주문(Short-Term) 특성:
  - 시퀀스 번호 없음 (best-effort)
  - 만료(GoodTilBlock) 이전에는 취소 불보장
  - GoodTilBlock = current_height + 3 권장 (약 5초 타이트한 만료)

장기 주문(Stateful) 특성:
  - 시퀀스 번호 사용 (Ethereum nonce 유사)
  - 온체인 합의를 통한 확정적 배치/취소

교체 패턴:
  // 주문 수정 시 새 주문을 같은 ID + 더 큰 GTB로 전송
  new_order = {
    clientId: existing_order.clientId,  // 같은 ID
    goodTilBlock: current_block + 5,    // 더 큰 값
    price: new_price,                   // 변경된 파라미터
    ...
  }
```

### 12.3 Hyperliquid CLOID

```
CLOID (Client Order ID):
  - 선택적 128-bit hex string (예: "0x0000000000000000000000000000001f")
  - 계정 내 고유성 요구

활용:
  - 주문 조회: {"type": "orderStatus", "user": "0x...", "oid": "0xCLOID"}
  - 주문 취소: cancelByCloid 액션
  - 주문 수정: oid 필드에 cloid 사용 가능

CLOID가 없는 경우:
  - 시스템이 자동으로 oid(integer) 할당
  - 응답에서 oid 확인 후 관리
```

### 12.4 Orderly Network client_order_id

```
POST /v1/order
{
  "client_order_id": "my-unique-order-001",  // 사용자 정의 고유 ID
  ...
}

특징:
  - 계정 내 고유 (브로커 범위 아님)
  - 중복 client_order_id 제출 시 에러 반환
  - 조회 API에서 client_order_id로 주문 검색 가능

멱등성 패턴:
  // 동일 client_order_id 재제출 시 서버 측 중복 처리
  // 네트워크 오류 후 안전하게 재시도 가능
```

### 12.5 HyperKRW 권장 Client Order ID 설계

```python
import uuid
import hashlib
import time

class OrderIdManager:
    """
    멱등 주문 ID 관리자
    """

    @staticmethod
    def generate_client_order_id(
        account_id: str,
        market: str,
        side: str,
        timestamp: int = None
    ) -> str:
        """
        결정론적 client order ID 생성
        같은 입력 → 같은 ID (네트워크 재시도에 안전)
        """
        if timestamp is None:
            timestamp = int(time.time() * 1000)

        # 의도 기반 ID (재시도 안전)
        raw = f"{account_id}:{market}:{side}:{timestamp}"
        return hashlib.sha256(raw.encode()).hexdigest()[:32]

    @staticmethod
    def generate_random_cloid() -> str:
        """
        완전 무작위 128-bit hex (Hyperliquid 형식 호환)
        """
        return "0x" + uuid.uuid4().hex.zfill(32)

    @staticmethod
    def validate_uniqueness(client_order_id: str, db) -> bool:
        """
        DB에서 중복 확인
        """
        return not db.order_exists_by_client_id(client_order_id)

# 주문 제출 패턴
def submit_order_with_idempotency(order_params, max_retries=3):
    client_order_id = OrderIdManager.generate_client_order_id(
        account_id=order_params["account_id"],
        market=order_params["market"],
        side=order_params["side"],
        timestamp=order_params.get("timestamp", int(time.time() * 1000))
    )

    for attempt in range(max_retries):
        try:
            response = submit_order({
                **order_params,
                "client_order_id": client_order_id
            })
            return response
        except DuplicateOrderError:
            # 이미 제출된 주문 → 기존 주문 상태 조회
            return get_order_by_client_id(client_order_id)
        except NetworkError:
            if attempt < max_retries - 1:
                time.sleep(0.1 * (2 ** attempt))  # 지수 백오프
            else:
                raise
```

---

## 13. HyperKRW 권장사항 (Recommendations)

### 13.1 아키텍처 권장사항

HyperKRW는 KRW 기반 영구 선물(Perpetual Futures) DEX로서 다음 아키텍처를 권장한다:

```
권장 아키텍처: Orderly Network 모델 참고 (Off-chain Matching + On-chain Settlement)

이유:
1. 온체인 전체 매칭(dYdX v4 방식)은 높은 기술 복잡도
2. 완전 오프체인(단순 CEX)은 탈중앙화 신뢰 불가
3. Off-chain Matching + On-chain Settlement = 최적 균형

구성:
  [사용자]
    ↓ API 요청
  [오프체인 매칭 엔진]  ← 레이턴시 최소화, price-time priority
    ↓ 체결 결과
  [온체인 Settlement Layer]  ← Arbitrum 또는 OP Stack
    ↓ 정기 배치
  [Ethereum L1]  ← 최종 결제 및 상태 검증
```

### 13.2 주문 유형 구현 우선순위

```
Phase 1 (MVP):
  ✅ Market Order (IOC 방식 구현)
  ✅ Limit Order (GTC)
  ✅ Post-Only Limit
  ✅ IOC (Immediate-or-Cancel)
  ✅ Reduce-Only

Phase 2 (Core):
  ✅ FOK (Fill-or-Kill)
  ✅ GTT (Good-Till-Time, 최대 4주)
  ✅ Stop-Loss (Market)
  ✅ Take-Profit (Market)

Phase 3 (Advanced):
  ✅ Stop-Limit
  ✅ Take-Profit Limit
  ✅ TWAP (30초 슬라이스)
  ✅ Scale Orders
```

### 13.3 펀딩 레이트 구현 권장

```
권장 방식: Hyperliquid/dYdX 하이브리드

공식:
  F = TWAP_Premium + clamp(0.01%/8h - TWAP_Premium, -0.05%, 0.05%)

  TWAP_Premium = 1시간 premium TWAP
  premium = (Impact_Bid - Index) - (Index - Impact_Ask) / Index

샘플링: 1분마다 (최소), 60개 → 1시간 TWAP
결제 주기: 1시간
캡: ±0.5%/시간 (Lighter 방식, 보수적)

KRW 특화:
  - 인덱스 가격: Upbit KRW + Bithumb KRW + (Binance USDT × USD/KRW)
  - 가중치: Upbit(3) + Bithumb(2) + Binance(2) + Okx(1)
  - 김치 프리미엄을 인덱스 가격에 자연 반영
```

### 13.4 오라클 설계 권장

```
KRW DEX 오라클 설계:

1차 소스 (국내):
  - Upbit KRW 스팟 가격 (가중치 3)
  - Bithumb KRW 스팟 가격 (가중치 2)

2차 소스 (해외 → KRW 환산):
  - Binance USDT × USD/KRW 환율 (가중치 2)
  - OKX USDT × USD/KRW 환율 (가중치 1)

USD/KRW 환율 소스:
  - 한국은행 환율 API
  - Chainlink USD/KRW 피드 (가용 시)

이상값 필터:
  - 중앙값 대비 ±5% 초과 소스 제외
  - 30초 이상 데이터 없는 소스 제외

업데이트 주기: 5초마다 (Hyperliquid 방식)
```

### 13.5 마진 시스템 권장

```
초기 구현:
  - 크로스 마진 (단순화)
  - 계정별 서브계정 지원 (최대 20개, EdgeX 방식)
  - IMF: 시장별 설정 (BTC/ETH: 2%, 알트코인: 5~10%)
  - MMF: IMF × 50%

레버리지:
  - BTC/ETH: 최대 50x
  - 주요 알트코인: 최대 20x
  - 기타: 최대 10x

추후 지원:
  - 아이솔레이티드 마진 (서브계정 방식)
  - 포트폴리오 마진 (Paradex 방식)
```

### 13.6 청산 엔진 권장

```
청산 설계 (Orderly + Hyperliquid 혼합):

트리거:
  Total Equity < Total Maintenance Margin (dYdX 방식)

1단계 - 오더북 청산:
  - 청산 주문을 오더북에 전송
  - Fillable Price = Oracle Price × (1 ± 1.5 × MMF)
  - 포지션 > 임계치: 20% 단위 청산

2단계 - 청산자 풀:
  - 분산 청산자 모델 (Orderly 방식)
  - 할인된 가격에 포지션 이전
  - 누구나 청산자 참여 가능

3단계 - 보험 펀드:
  - 청산자 없을 시 보험 펀드가 포지션 인수
  - 수수료 분배: 청산자 60%, 보험 펀드 40%

4단계 - ADL (최후 수단):
  - 보험 펀드 고갈 시 발동
  - 고레버리지 수익 포지션 강제 감소

청산 수수료:
  BTC/ETH: 0.5%
  기타: 1.0%
```

### 13.7 STP 구현 권장

```
권장: Paradex 방식 3-mode STP

기본값: EXPIRE_TAKER (테이커 주문 취소)
이유: 메이커는 LP, 테이커가 새 의도를 가진 것으로 해석

구현:
  order.stp_mode: "EXPIRE_MAKER" | "EXPIRE_TAKER" | "EXPIRE_BOTH"

동일 계정 정의:
  - 같은 master account (서브계정 무관) = 자기 거래
  - 또는 같은 subaccount만 = 자기 거래 (더 관대한 방식)

권장: 같은 master account 기준 STP 적용
```

### 13.8 API 설계 권장

```
REST API 구조:

Base: https://api.hyperkrw.exchange/v1/

Public (인증 불필요):
  GET /v1/markets                    # 시장 목록
  GET /v1/markets/{market}/orderbook # 오더북 (L2)
  GET /v1/markets/{market}/trades    # 최근 체결
  GET /v1/markets/{market}/candles   # 캔들스틱
  GET /v1/funding_rates/{market}     # 펀딩 레이트
  GET /v1/index_price/{market}       # 인덱스 가격

Private (인증 필요, ed25519 서명):
  POST   /v1/orders                  # 주문 생성
  DELETE /v1/orders/{order_id}       # 주문 취소
  DELETE /v1/orders                  # 전체 취소 (?market=)
  POST   /v1/orders/batch            # 배치 주문
  GET    /v1/orders                  # 미체결 주문
  GET    /v1/orders/{order_id}       # 주문 조회
  GET    /v1/positions               # 포지션
  GET    /v1/account                 # 계정 정보
  GET    /v1/fills                   # 체결 내역
  GET    /v1/funding_history         # 펀딩 수취/지불 이력

WebSocket:
  Public:  wss://ws.hyperkrw.exchange/v1/public
  Private: wss://ws.hyperkrw.exchange/v1/private/{account_id}

  채널:
    orderbook.{market}      # L2 오더북 업데이트
    trades.{market}         # 체결 스트림
    candles.{market}.{interval}  # 캔들
    funding.{market}        # 펀딩 레이트 업데이트

  Private 채널:
    orders                  # 주문 상태 업데이트
    positions               # 포지션 업데이트
    fills                   # 체결 통보
    account                 # 계정 잔액 업데이트

인증 (Orderly 방식):
  알고리즘: ed25519
  헤더:
    orderly-account-id: {account_id}
    orderly-key: {public_key}
    orderly-signature: {signature}
    orderly-timestamp: {unix_ms}

Rate Limit:
  Public: IP당 100 req/s
  Private: 계정당 50 req/s
  WS: 계정당 100 subscriptions
```

### 13.9 수수료 구조 권장

```
초기 수수료 (경쟁력 있는 설정):

Maker: -1 bps (리베이트) — dYdX v4 참고
Taker:  3 bps              — Orderly 기준

30일 거래량 티어:
  < 10억 원:     Taker 3 bps
  10억~50억:    Taker 2.5 bps
  50억~200억:   Taker 2 bps
  200억~1000억: Taker 1.5 bps
  > 1000억:     Taker 1 bps

브로커 모델 (Orderly 방식):
  - 서드파티 DEX 빌더가 추가 수수료 설정 가능
  - HyperKRW 기본 수수료 위에 부과
  - 브로커 수익 100% 보유

보험 펀드 기여:
  청산 수수료의 40% → 보험 펀드
  청산 수수료의 60% → 청산자
```

---

## 참고 소스 (Sources)

### 공식 문서
- [dYdX v4 Chain GitHub](https://github.com/dydxprotocol/v4-chain)
- [dYdX v4 Documentation](https://docs.dydx.xyz/)
- [Hyperliquid Documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/)
- [Paradex Documentation](https://docs.paradex.trade/)
- [EdgeX Documentation](https://edgex-1.gitbook.io/edgeX-documentation)
- [Vertex Protocol Documentation](https://docs.vertexprotocol.com/)
- [Orderly Network Documentation](https://orderly.network/docs/)
- [Lighter Documentation](https://docs.lighter.xyz/)

### 기술 논문 / 블로그
- [Lighter Protocol Whitepaper](https://assets.lighter.xyz/whitepaper.pdf)
- [dYdX v4 Architectural Evolution (Medium)](https://medium.com/@gwrx2005/dydx-v4-architectural-and-protocol-evolution-from-v3-6c312f51f7b7)
- [Decentralized Order Book Design in dYdX v4 (Medium)](https://medium.com/@gwrx2005/decentralized-order-book-design-in-dydx-v4-625ac0152e80)
- [Orderly Network Liquidation Engine Deep Dive](https://orderly.network/blog/orderly-network-liquidation-engine-a-deep-dive-/)
- [Hyperliquid ADL Event Analysis (WuBlock)](https://wublock.substack.com/p/hyperliquid-activates-cross-margin)

### GitHub 레포지토리
- [dydxprotocol/v4-chain](https://github.com/dydxprotocol/v4-chain)
- [vertex-protocol/vertex-contracts](https://github.com/vertex-protocol/vertex-contracts)
- [vertex-protocol/vertex-typescript-sdk](https://github.com/vertex-protocol/vertex-typescript-sdk)
- [OrderlyNetwork/orderly-sdk-js](https://github.com/OrderlyNetwork/orderly-sdk-js)
- [OrderlyNetwork/orderly-evm-connector-python](https://github.com/OrderlyNetwork/orderly-evm-connector-python)

---

## 14. HyperKRW 구현 현황 vs. 오픈소스 비교 분석

**추가 작성:** 2026년 4월 2일
**목적:** 현재까지 구현된 HyperKRW 코드를 동종 오픈소스 DEX와 기능별로 비교하고, 차이(Gap)를 명확히 정리

---

### 14.1 전체 기능 구현 현황 비교표

| 기능 영역 | HyperKRW 현황 | dYdX v4 | Hyperliquid | Orderly | Paradex | 평가 |
|---------|-------------|---------|-------------|---------|---------|------|
| **오더북 (CLOB)** | ✅ Price-Time Priority, 인메모리 | ✅ (인메모리+온체인) | ✅ (온체인 BFT) | ✅ (오프체인) | ✅ (오프체인) | ✅ 동급 |
| **Market Order** | ✅ IOC 방식 | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **Limit Order (GTC)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **IOC / FOK** | ❌ 미구현 | ✅ | ✅(IOC만) | ✅ | ✅ | ⚠️ Phase 2 필요 |
| **Post-Only** | ❌ 미구현 | ✅ | ✅ (ALO) | ✅ | ✅ | ⚠️ Phase 2 필요 |
| **Reduce-Only** | ❌ 미구현 | ✅ | ✅ | ✅ | ✅ | ⚠️ Phase 2 필요 |
| **Stop-Loss / Take-Profit** | ❌ 미구현 | ✅ | ✅ | ❌ (문서 없음) | ✅ | ⚠️ Phase 3 필요 |
| **TWAP** | ❌ 미구현 | ✅ (v9.0+) | ✅ (30초) | ❌ | ✅ | ⚠️ Phase 3 필요 |
| **STP (자기거래방지)** | ✅ EXPIRE_TAKER/MAKER/BOTH | ❌ (서브계정 수준) | ❌ (암묵적) | ❌ | ✅ (동일 3-mode) | ✅ **최상위 수준** |
| **펀딩 레이트 (서버)** | ✅ 1시간 결제, ±600% 캡 | ✅ 1시간 | ✅ 1시간 | ✅ 8시간 | ✅ 연속 | ✅ 경쟁력 있음 |
| **펀딩 결제 (온체인)** | ✅ `settleFunding()` | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **마크 가격 (3-component)** | ✅ Median(P1, P2, MidPrice) | P=Oracle | ✅ 3-component | ✅ (Orderly 방식) | ✅ | ✅ **업계 표준 달성** |
| **마크 가격 온체인 포스팅** | ✅ `postMarkPrice()` ±20% 가드 | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **크로스 마진** | ✅ totalBalance 기준 | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **아이솔레이티드 마진** | ✅ freeMargin 기준 | ❌ | ✅ | ❌ | ❌ | ✅ 경쟁 우위 |
| **레버리지 강제** | ✅ `requiredMargin()` | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **파셜 청산 (20%)** | ✅ 최대 5단계 | ❌ (전체 청산) | ✅ ($100k+) | ✅ | ✅ | ✅ 동급 |
| **ADL** | ✅ `settleADL()`, InsuranceFund 잔액 0 확인 | ✅ | ✅ | ✅ | ✅ (Socialized Loss) | ✅ 동급 |
| **보험 펀드 (인메모리)** | ✅ `IInsuranceFund` DI | - | - | - | - | ✅ 서버측 |
| **보험 펀드 (온체인)** | ✅ `InsuranceFund.sol` pairId+token 2중 키 | ✅ | ✅ (HLP) | ✅ | ✅ | ✅ 동급 |
| **청산 수수료** | ❌ 미정의 | ✅ 최대 1.5% | ✅ 0% (잔여마진 보존) | ✅ 0.6~1.2% | ✅ 70%MMR 연계 | ⚠️ 명시 필요 |
| **EIP-712 서명 결제** | ✅ `OrderSettlement.sol` | ❌ (Cosmos 서명) | ❌ | ✅ | ✅ (StarkNet) | ✅ EVM 최상급 |
| **Bitmap Nonce (재사용 방지)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 동급 |
| **UUPS 업그레이더블** | ✅ 전 컨트랙트 | ❌ (Cosmos) | ❌ | ✅ | ✅ | ✅ 동급 |
| **Compliance (블록리스트)** | ✅ `BasicCompliance.sol` | ✅ | ❌ | ✅ | ✅ | ✅ 동급 |
| **Client Order ID 중복 방지** | ✅ open 상태 중복 409 반환 | ✅ (교체) | ✅ (128-bit hex) | ✅ | ✅ | ✅ 동급 |

---

### 14.2 영역별 심층 비교

#### 14.2.1 펀딩 레이트 캡 — 명확화 필요

현재 HyperKRW 서버의 `FundingRateEngine`:
```
MAX_RATE_SCALED = 6n * RATE_SCALE   // = ±600%
```

**문제점:** ±600%는 **8시간 기준** 캡인지, **시간당** 캡인지 명확하지 않음.

| DEX | 캡 공식 | 기준 주기 |
|-----|--------|---------|
| dYdX v4 | `600% × (IMF - MMF)` | 8시간 |
| Hyperliquid | ±4% | 1시간 |
| Lighter | ±0.5% | 1시간 |
| Paradex | ±5% | 8시간 |
| Vertex | ±10% | 1일 |
| **HyperKRW** | ±600% | **불명확** |

**권장 조치:**
- BTC/ETH 기준 IMF=5%, MMF=2.5% 적용 시 `dYdX 방식 캡 = 600% × 2.5% = 15%/8h`
- 또는 `Hyperliquid 방식 = ±4%/h`로 변경
- **현재 ±600%는 사실상 캡 없는 것과 동일** — 수정 권장

#### 14.2.2 마크 가격 — 업계 최상급 구현

HyperKRW의 현재 구현:
```typescript
// MarkPriceOracle.ts
P1 = indexPrice + indexPrice * rateScaled * timeScaled / (RATE_SCALE * RATE_SCALE)
P2 = indexPrice + movingAvgBasis
midPrice = median(bestBid, bestAsk, lastPrice)
markPrice = median(P1, P2, midPrice)
```

Orderly Network 공식 참조 구현과 **구조적으로 동일**. dYdX v4(오라클 가격만 사용)보다 정교.

**강점:**
- bigint 전용 연산 → 부동소수점 오차 없음
- 분자를 먼저 곱한 후 나눔 → 정밀도 손실 최소화

**추가 권장 사항:** 인덱스 가격 소스를 단일 소스에서 국내 거래소 멀티소스로 확장 (섹션 13.4 참조)

#### 14.2.3 청산 엔진 — 파셜 청산 경쟁력 있음

| 항목 | HyperKRW | dYdX v4 | Hyperliquid | Orderly |
|------|---------|---------|-------------|---------|
| 파셜 청산 | ✅ 20% × 5단계 | ❌ 전체 청산 | ✅ ($100k 이상) | ✅ IMR 복구까지 |
| 청산 수수료 | ❌ **미정의** | 최대 1.5% | 0% (잔여마진) | 0.6~1.2% |
| ADL 순위 기준 | ❌ **미정의** | PnL/마진율 기준 | 비공개 | AMR 기반 |
| 청산 이벤트 로깅 | ✅ `LiquidationSettled` | ✅ | ✅ | ✅ |

**중요 미비 사항:**
1. **청산 수수료** — 얼마를 보험 펀드/청산자에게 분배할지 정의 없음
2. **ADL 대상 선정 순위** — Hyperliquid은 "고레버리지 고수익 포지션" 기준, dYdX는 PnL/마진율 기준. HyperKRW `settleADL()`은 호출자가 entries 배열을 제공하므로 순위 정책이 서버 측 비즈니스 로직에 있어야 함 — 미문서화

#### 14.2.4 온체인 결제 아키텍처 — EVM 최고 수준

| 항목 | HyperKRW | Orderly | Vertex | Paradex |
|------|---------|---------|--------|---------|
| 서명 방식 | EIP-712 타입드 해시 | EIP-712 | EIP-712 | StarkNet 서명 |
| Nonce | Bitmap (비트맵) | 시퀀셜 | 시퀀셜 | 시퀀셜 |
| 업그레이드 | UUPS 프록시 | ✅ | 일부 | ✅ |
| 배치 결제 | ✅ `settleBatch()` | ✅ | ✅ | ✅ |
| 청산 결제 | ✅ `settleLiquidation()` | ✅ | ✅ | ✅ |
| ADL 결제 | ✅ `settleADL()` | ✅ | 미기재 | ✅ |
| 펀딩 결제 | ✅ `settleFunding()` | ✅ | ✅ | ✅ |

**강점:** Bitmap nonce는 dYdX v4 방식으로 주문 취소 없이 비트만 플립 → 가스 효율 우수

#### 14.2.5 보험 펀드 설계 비교

| 항목 | HyperKRW | Hyperliquid HLP | dYdX v4 | Orderly |
|------|---------|----------------|---------|---------|
| 구조 | `InsuranceFund.sol` (온체인) + 인메모리 | HLP Vault (커뮤니티 운용) | 별도 모듈 | 프로토콜 소유 |
| 자금 원천 | 청산 수수료 (미정의) | 플랫폼 수익 + LP | 펀딩 수수료 일부 | 청산 수수료 50% |
| 권한 구조 | OPERATOR_ROLE | DAO | 거버넌스 | 프로토콜 |
| ADL 연동 | ✅ `balance==0` 확인 후 ADL | ✅ | ✅ | ✅ |

**현재 HyperKRW 이슈:**
- 보험 펀드 충전 메커니즘 미정의 — 청산 수수료 → 보험 펀드 자동 적립 로직 없음
- 인메모리(서버) 보험 펀드와 온체인 `InsuranceFund.sol` 간 동기화 메커니즘 없음

---

### 14.3 HyperKRW vs. 피어 — Gap 분석 요약

#### 🔴 Critical Gaps (MVP 출시 전 해결 필요)

| #  | 항목 | 현황 | 권장 조치 |
|----|------|------|---------|
| G-1 | **펀딩 레이트 캡 재정의** | `±600%` 모호 | `±4%/h` 또는 `±15%/8h` 명확화 |
| G-2 | **청산 수수료 미정의** | 없음 | `OrderSettlement.sol`에 fee bps 파라미터 추가 |
| G-3 | **보험 펀드 자동 충전** | 없음 | 청산 수수료 일부 → InsuranceFund 자동 이체 로직 |
| G-4 | **ADL 대상 순위 정책** | 미문서화 | 서버 `settleADL` 호출 시 순위 알고리즘 명세 |

#### 🟡 High Priority Gaps (테스트넷 이후 구현)

| #  | 항목 | 현황 | 권장 조치 |
|----|------|------|---------|
| G-5 | **IOC/FOK 주문** | 미구현 | `MatchingEngine.ts`에 TIF 옵션 추가 |
| G-6 | **Post-Only 주문** | 미구현 | 매칭 전 즉시 체결 여부 사전 검증 |
| G-7 | **Reduce-Only 플래그** | 미구현 | `Order` 타입에 `reduceOnly: boolean` 추가 |
| G-8 | **Stop-Loss / Take-Profit** | 미구현 | 조건부 주문 엔진 설계 필요 |
| G-9 | **인메모리↔온체인 InsuranceFund 동기화** | 없음 | 블록 이벤트 구독으로 온체인 → 인메모리 반영 |

#### 🟢 Low Priority Gaps (Phase 3 이후)

| #  | 항목 | 현황 | 권장 조치 |
|----|------|------|---------|
| G-10 | **TWAP 주문** | 미구현 | 30초 슬라이스 실행 엔진 |
| G-11 | **KRW 멀티소스 오라클** | 단일 소스 | Upbit+Bithumb+Binance×환율 가중 평균 |
| G-12 | **서브계정** | 없음 | 계정당 최대 20개 서브계정 |
| G-13 | **포트폴리오 마진** | 없음 | Paradex/Vertex 방식 상관관계 마진 |

---

### 14.4 HyperKRW 고유 강점 (vs. 모든 피어)

1. **3-mode STP**: EXPIRE_TAKER/MAKER/BOTH — dYdX, Hyperliquid, Orderly 모두 미지원. Paradex만 동일 수준
2. **Isolated Margin 지원**: Orderly, Paradex, dYdX v4는 Cross만. Hyperliquid만 동일 지원
3. **bigint 전용 재무 수학**: JavaScript 서버에서 Number 사용 금지 — CEX 수준 정밀도
4. **EIP-712 + Bitmap Nonce**: 재사용 방지와 가스 효율의 최적 조합
5. **KRW 기반**: 김치 프리미엄을 인덱스 가격에 자연 반영 가능한 유일한 구조

---

### 14.5 구체적 개선 우선순위 (다음 세션 참고)

#### Phase 2A — 테스트넷 전 (Critical)
```
1. G-1: FundingRateEngine MAX_RATE_SCALED 재정의
   - 현행: 6n * RATE_SCALE (±600%)
   - 변경안: 4n * RATE_SCALE / 100n (±4%/h = Hyperliquid 수준) 검토
   - 또는: dYdX 방식 600% × (IMF-MMF) 동적 계산

2. G-2: settleLiquidation()에 청산 수수료 추가
   - 파라미터: uint256 liquidationFeeBps (예: 50 = 0.5%)
   - 수수료 분배: 60% → 보험펀드, 40% → 프로토콜

3. G-3: InsuranceFund 자동 충전
   - settleLiquidation() 완료 시 fee → InsuranceFund.deposit() 호출
```

#### Phase 2B — 테스트넷 직후
```
4. G-5~G-7: IOC/FOK/Post-Only/Reduce-Only
   - Order 타입에 TimeInForce enum 추가
   - MatchingEngine 로직 분기 추가

5. G-8: 조건부 주문 (Stop-Loss/Take-Profit)
   - TriggerOrderEngine 신규 모듈
   - postMarkPrice() 업데이트 시 조건 확인
```

---

### 14.6 오픈소스 코드 참조 포인트

현재 HyperKRW 구현과 가장 유사한 오픈소스 참조점:

| HyperKRW 컴포넌트 | 참조 소스 | 유사도 |
|----------------|---------|--------|
| `MatchingEngine.ts` | [dYdX v4 memclob](https://github.com/dydxprotocol/v4-chain/tree/main/protocol/x/clob/memclob) | 알고리즘 동일 (언어 다름) |
| `MarkPriceOracle.ts` | [Orderly Network mark price](https://orderly.network/docs/build-on-omnichain/trade-data/mark-price) | 공식 동일 |
| `FundingRateEngine.ts` | [dYdX v4 funding](https://docs.dydx.xyz/trading/funding) + [Hyperliquid funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding) | 하이브리드 |
| `LiquidationEngine.ts` | [Paradex partial liquidation](https://docs.paradex.trade/documentation/risk-management/liquidations) | 20% 단계 동일 |
| `OrderSettlement.sol` | [Orderly EVM contracts](https://github.com/OrderlyNetwork/contract-evm) | EIP-712 구조 유사 |
| `InsuranceFund.sol` | [dYdX v4 insurance](https://github.com/dydxprotocol/v4-chain/tree/main/protocol/x/insurancefund) | pairId 분리 구조 차별화 |
| `MarginRegistry.sol` | [Hyperliquid margin](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/margin) | 개념 동일, 구현 독자적 |

---

*섹션 14 추가 작성: 2026년 4월 2일. HyperKRW C-1~C-6 컨트랙트 완료 후 현황 기준.*

---

*이 문서는 2026년 3월 31일 기준으로 각 DEX의 공개 문서, GitHub 레포지토리, 공식 API 문서를 기반으로 작성되었습니다. 각 프로토콜은 지속적으로 업데이트되므로, 구체적인 구현 전에 최신 공식 문서를 반드시 확인하세요.*


---

## 15. 2026-04-06 종합 비교 분석 (Comprehensive Comparative Analysis)

**작성일:** 2026년 4월 6일
**분석 기준:** 세션 3 완료 이후 상태 (krw-dex-server master d9a33f9, krw-dex-contracts main 1fa6d80, krw-dex-web master dc23e43)
**범위:** 아키텍처 포지셔닝, 보안·컴플라이언스, 구현 격차, 테스트넷 준비도
**참고:** 본 섹션은 섹션 1–14의 내용을 중복하지 않으며, 2026-04-06 기준 신규 데이터 및 교차 비교에 집중한다.

---

### 15.1 경쟁사 아키텍처 포지셔닝 매트릭스 (Competitor Architecture Positioning Matrix)

#### 15.1.1 2×2 아키텍처 사분면

아래 매트릭스는 X축 = 탈중앙화 수준(낮음→높음), Y축 = 처리량/레이턴시(낮음→높음)로 7개 경쟁사와 HyperKRW의 포지셔닝을 보여준다.

```
HIGH THROUGHPUT / LOW LATENCY
        |
        |  * Hyperliquid (HyperBFT, 200k ord/s, ~1s finality)
        |  * Lighter (zk-rollup, ETH-settled, CEX UX)
        |                     * dYdX v4 (Cosmos BFT, ~1s)
        |         * HyperKRW (off-chain CLOB + HyperEVM settle)
        |  * Vertex (off-chain seq, 5-15ms match)
        |  * Orderly (off-chain seq, OP Stack settle)
        |                     * Paradex (off-chain + StarkNet appchain)
        |                     * EdgeX (StarkEx, off-chain match)
        |
LOW     +------------------------------------------------------------>
     CENTRALIZED                                    DECENTRALIZED
     (team-controlled)                         (validator-distributed)
```

**HyperKRW 포지셔닝 해설:**
- 매칭은 단일 오퍼레이터(중앙화)이나, EIP-712 서명 + 비트맵 논스로 사용자 자산은 자기 수탁
- 결제가 HyperEVM(분산) 위에서 이루어지므로 Vertex/Orderly보다 우측에 위치
- Hyperliquid보다 처리량이 낮으나 HyperEVM 위에서 동작하므로 HyperBFT 합의 보안 수혜

#### 15.1.2 결제 최종성(Settlement Finality) 비교

| 시스템 | 매칭 레이턴시 | 온체인 결제 레이턴시 | 암호학적 최종성 | 결제 레이어 |
|--------|------------|-----------------|---------------|-----------|
| dYdX v4 | ~1ms (in-memory) | ~1s (CometBFT 블록) | ~2s (2/3 검증인 서명) | Cosmos SDK 자체 체인 |
| Hyperliquid | ~1ms (HyperCore) | ~1s (HyperBFT 블록) | ~2s (one-block finality) | HyperBFT L1 |
| Lighter | <1ms (off-chain) | ~12s (ETH L1 배치) | ~12s (ETH PoS 최종성) | Ethereum L1 (zk-proof) |
| Paradex | <5ms (off-chain) | ~2s (StarkNet appchain) | ~분 단위 (L1 proof 제출) | StarkNet L2 |
| EdgeX | <10ms (off-chain) | ~분 단위 (StarkEx 배치) | ~시간 단위 (ETH L1 증명) | StarkEx L2 |
| Vertex | 5-15ms (off-chain) | ~250ms (Arbitrum One) | ~1주 (Arbitrum finality) | Arbitrum L2 |
| Orderly | <10ms (off-chain) | ~2s (OP Stack L2) | ~7일 (Optimism 도전 기간) | OP Stack L2 |
| **HyperKRW** | **<5ms (off-chain CLOB)** | **~1s (HyperEVM 패스트 블록)** | **~2s (HyperBFT 합의)** | **HyperEVM (HyperBFT L1 위)** |

> HyperEVM 기술 사양 (2026-04-06 기준): 패스트 블록 1초 / 가스 2M, 슬로우 블록 1분 / 가스 30M. 독립 멤풀 2개 운영. 주소당 다음 8개 논스까지만 수용. 24시간 초과 트랜잭션 자동 pruning. EIP-1559 활성화, HYPE 네이티브 가스 토큰. 패스트 블록 기본 수수료 1 gwei, 슬로우 블록 0.5 gwei.

#### 15.1.3 신뢰 모델 (Trust Model) 비교

| 시스템 | 매칭 신뢰 주체 | 결제 보증 방식 | 업그레이드 거버넌스 |
|--------|-------------|-------------|----------------|
| dYdX v4 | 합의 검증인 집합 (CometBFT, 60개 이상) | 온체인 Cosmos 상태 머신 | 거버넌스 투표 (DYDX 토큰) |
| Hyperliquid | HyperBFT 검증인 집합 | 온체인 HyperBFT 상태 | 팀 주도 업그레이드 (검증인 업그레이드 투표) |
| Lighter | 중앙화 시퀀서 (증명 생성) | zk-SNARK proof → ETH L1 컨트랙트 | 팀 멀티시그 (공개 미확인) |
| Paradex | Paradigm 운영 오프체인 매칭 | ZK proof → StarkNet L1 검증 | Paradigm 팀 + StarkNet 거버넌스 |
| Vertex | Vertex 오프체인 시퀀서 | Arbitrum 온체인 리스크 엔진 | 멀티시그 (구체 구성 비공개) |
| Orderly | Orderly 오프체인 매칭 | OP Stack L2 → ETH L1 | 팀 운영 멀티시그 |
| **HyperKRW** | **단일 OPERATOR_ROLE (Vault AppRole)** | **EIP-712 서명 → HyperEVM 온체인** | **Gnosis Safe 2-of-3 + TimelockController 48h** |

**HyperKRW 거버넌스 차별점:** TimelockController 48h 업그레이드 지연은 경쟁사 중 문서화된 유일한 사례이다. Hyperliquid는 팀 주도 즉시 업그레이드가 가능하며, Vertex와 Orderly의 멀티시그는 시간 지연 없이 즉시 실행된다. 48시간 창은 커뮤니티나 감사자가 악의적 업그레이드를 탐지하고 GUARDIAN이 pause로 대응할 수 있는 시간을 제공한다.

---

### 15.2 보안 모델 심층 비교 (Security Model Deep Comparison)

#### 15.2.1 키 관리 비교

| 시스템 | 트레이딩 서명 키 유형 | 핫키 분리 방식 | 감사 가능성 |
|--------|------------------|-------------|-----------|
| Hyperliquid | Agent Wallet (EVM 서브키) | 메인 지갑 → Agent Wallet 위임. 만료 없음(Dead Man's Switch로 보완) | 온체인 위임 이벤트로 추적 가능 |
| Paradex | STARK 키 (StarkNet 네이티브) | 지갑에서 STARK 키 파생. 표준 StarkNet 서명 | StarkNet 블록 탐색기 |
| Orderly | ed25519 키 쌍 | 브로커 레벨 API 키 격리 | 오프체인 (감사 한계) |
| Vertex | ECDSA (EOA 서명) | 별도 서브키 문서화 미확인 | 오프체인 (감사 한계) |
| dYdX v4 | ECDSA + onchain subaccount | 메인 지갑이 서브계정을 소유 | Cosmos 체인 탐색기 |
| **HyperKRW** | **EIP-712 ECDSA (오퍼레이터 키)** | **HashiCorp Vault AppRole — 키 자체를 Vault에 격리** | **Vault 감사 로그 + 온체인 이벤트** |

**평가:** HyperKRW의 HashiCorp Vault AppRole 통합(R-2)은 경쟁사 오픈소스 코드에서 문서화된 유사 사례가 없다. Vault는 키 자체가 메모리에 평문으로 존재하지 않음을 보장하며, AppRole의 `secret_id` 로테이션으로 키 탈취 창을 최소화한다. Hyperliquid Agent Wallet은 사용자 편의성 측면에서 우수하나 오퍼레이터 키 보안 수준은 HyperKRW Vault가 더 강력하다.

#### 15.2.2 업그레이드 메커니즘 비교

| 시스템 | 프록시 패턴 | 업그레이드 권한 | 시간 지연 | 비상 정지 |
|--------|----------|-------------|---------|---------|
| dYdX v4 | Cosmos 거버넌스 (소프트웨어 업그레이드 제안) | DYDX 토큰 홀더 투표 | 거버넌스 투표 기간 (~7일) | 거버넌스 또는 긴급 거버넌스 |
| Hyperliquid | 자체 노드 업그레이드 | 검증인 집합 업그레이드 | 즉시 (문서화된 timelock 없음) | HYPE 소각 거버넌스 제안 |
| Lighter | EVM 컨트랙트 (구체 미공개) | 팀 멀티시그 추정 | 미공개 | 미공개 |
| Paradex | StarkNet 업그레이드 | Paradigm 팀 주도 | 미공개 | 미공개 |
| Vertex | EVM 컨트랙트 멀티시그 | 팀 멀티시그 | 즉시 (문서화된 timelock 없음) | 멀티시그 pause |
| Orderly | OP Stack 업그레이드 | 팀 멀티시그 | 즉시 | 팀 멀티시그 |
| **HyperKRW** | **UUPS (OpenZeppelin v5, 7개 컨트랙트)** | **Gnosis Safe 2-of-3 멀티시그** | **TimelockController 48h** | **GUARDIAN_ROLE pause-only (즉시), ADMIN-only unpause** |

**GUARDIAN 비대칭 설계의 중요성:** GUARDIAN은 pause만 가능하고 unpause는 DEFAULT_ADMIN(Gnosis Safe 2-of-3)만 가능하다. 이는 단일 키 탈취로 인한 완전한 서비스 재개를 방지하며, Vertex/Orderly의 단순 멀티시그보다 강력한 긴급 대응 체계를 제공한다.

#### 15.2.3 컴플라이언스 인터페이스 비교

| 시스템 | 컴플라이언스 방식 | 교체 가능성 | OFAC 스크리닝 |
|--------|--------------|-----------|-------------|
| dYdX v4 | 프론트엔드 지오블록 + 노드 레벨 주소 필터 | 불가 (코드 변경 필요) | 부분적 (지갑 주소 레벨) |
| Hyperliquid | 프론트엔드 지오블록 (미국 VPN 우회 가능) | 불가 | 미문서화 |
| Lighter | 미공개 | 미공개 | 미공개 |
| Paradex | 프론트엔드 지오블록 | 불가 | 미문서화 |
| Vertex | 프론트엔드 지오블록 | 불가 | 미문서화 |
| Orderly | 브로커 레벨 지오블록 | 불가 (브로커 재구현 필요) | 미문서화 |
| **HyperKRW** | **`IComplianceModule` 인터페이스 + `BasicCompliance.sol`** | **온체인 핫스왑 가능 (재배포 불필요)** | **OFAC SDN 로컬 + Chainalysis API 선택적** |

**IComplianceModule 핫스왑의 의의:** `OrderSettlement.setComplianceModule(newModule)` 호출 한 번으로 컴플라이언스 로직 전체를 교체할 수 있다. 예를 들어, VASP 라이선스 취득 시 `FullKYCCompliance.sol`로 전환이 가능하다. 경쟁사 중 이 수준의 유연성을 갖춘 시스템은 확인되지 않는다.

---

### 15.3 파생상품 엔진 비교 (Derivatives Engine Comparison)

#### 15.3.1 펀딩 레이트 2026-04-06 현황

| 시스템 | 결제 주기 | 캡(cap) | 계산 방식 | 정밀도 |
|--------|---------|--------|---------|------|
| dYdX v4 | 1시간 | 없음 (시장 기반) | 60분 샘플 TWAP × IMF 보정 | Go int64 (충분) |
| Hyperliquid | 1시간 (8h rate / 8) | ±4%/h (= ±32%/8h) | 지수 이동평균 기반 | 자체 정수 구현 |
| Lighter | 1시간 | 미공개 | 미공개 | zk-circuit (정수) |
| Paradex | 5초 연속 적립 | 미공개 | 연속 accrual 모델 | STARK felt252 |
| Vertex | 1시간 TWAP | 미공개 | TWAP 기반 | EVM uint256 |
| Orderly | 8시간 (1h/4h/8h 가변) | 미공개 | 미공개 | 오프체인 계산 |
| **HyperKRW** | **1시간 (CR-4 fix: settleFunding() 연결됨)** | **±4%/h (Hyperliquid 동일)** | **P1/P2/midPrice 중앙값 기반** | **bigint 전용 (SUG-6 잔존)** |

**SUG-6 잔존 위험:** `FundingRateEngine.computeRate()`가 `Number(markPrice - indexPrice) / Number(indexPrice)` 패턴을 사용한다. ETH 가격 약 4,000,000 KRW일 때, `markPrice × leverage × position_size`는 용이하게 2^53(약 9×10^15)을 초과한다. 중간 계산 중 정밀도 손실이 발생할 수 있다. 수정 공수: 1시간 미만.

#### 15.3.2 청산 실사례 — Hyperliquid ADL 이벤트 (2025년 10월)

**배경:** 2025년 10월 11일, 크립토 시장에서 역대 최대 단일일 청산이 발생했다. 전체 시장 약 190억 달러가 청산되었으며, Hyperliquid에서만 103억 달러(Binance 24억 달러, Bybit 46억 달러 대비 압도적 비중)가 청산되었다.

**ADL 연쇄 발동:** Hyperliquid는 이 이벤트에서 크로스마진 ADL을 사상 처음 발동했다. 12분 내 21억 달러 규모 포지션을 ADL로 강제 감축, 10분간 40회 이상의 ADL 이벤트가 기록되었다. 약 3만 5천 개 포지션, 2만 명의 트레이더에게 영향을 미쳤다.

**결과:** Hyperliquid는 영구 bad debt 없이 100% 업타임을 유지했다. HLP(Hyperliquidity Provider) Vault가 백스톱 역할을 수행했으나 오픈 인터레스트는 사건 직후 50% 감소했다.

**HyperKRW 함의:**

| 비교 항목 | Hyperliquid (실전 경험) | HyperKRW (현재 상태) |
|---------|----------------------|------------------|
| ADL 구현 | 완전 온체인, 실전 검증됨 | 구현됨 (IMP-8 dual state 위험) |
| 청산 가격 | mark price 사용 | IMP-4: price=0n (온체인 결제 시 quoteAmount=0 버그) |
| 보험기금 백스톱 | HLP Vault (수억 달러 규모) | InsuranceFund (in-memory, 재시작 시 소실 위험) |
| 실전 테스트 | 2년 운영 후 첫 ADL | 프로덕션 미경험 |
| 상태 일관성 | 단일 온체인 상태 | IMP-8: MarginAccount + PositionTracker 이중 상태 |

**중요:** IMP-8(이중 상태)와 IMP-4(price=0n)는 Hyperliquid의 2025년 10월 이벤트와 같은 스트레스 상황에서 치명적 결과를 초래할 수 있다. 테스트넷 배포 전 필수 수정.

#### 15.3.3 마크 가격 신뢰성 비교

| 시스템 | 마크 가격 소스 | 탈중앙화 수준 | 스탈니스 보호 |
|--------|------------|------------|------------|
| dYdX v4 | Slinky (검증인 투표 기반 멀티소스 오라클) | 높음 (2/3 검증인 합의) | 내장 (ABCI 주기 업데이트) |
| Hyperliquid | HyperBFT 오라클 (검증인 집합 투표) | 높음 (HyperBFT 합의 내) | 내장 (블록마다 업데이트) |
| Lighter | 미공개 (zk-circuit 내 검증) | 미공개 | zk-proof 내 보장 |
| Paradex | 오프체인 오라클 (Pragma 추정) | 낮음 (오프체인) | 미문서화 |
| Vertex | 오프체인 오라클 | 낮음 (오프체인) | 미문서화 |
| Orderly | P1/P2/midPrice 중앙값 (오프체인) | 낮음 (오프체인) | Orderly 문서에 명시 없음 |
| **HyperKRW** | **P1/P2/midPrice 중앙값 (Orderly 패턴), OPERATOR_ROLE 게시** | **낮음 (단일 오퍼레이터)** | **SUG-1: 스탈니스 체크 없음** |

**HyperKRW 오라클 중앙화 위험:** `OracleAdmin.postMarkPrice()`는 OPERATOR_ROLE 단일 계정이 게시한다. 키 탈취 시 ±20% 델타 가드가 1차 방어선이지만, 공격자가 점진적으로(매번 19.9%씩) 가격을 조작하면 10회 업데이트 만에 5배 가격 왜곡이 가능하다. SUG-1(스탈니스 체크)과 함께 멀티소스 오라클 로드맵이 장기적으로 필요하다.

---

### 15.4 인프라 성숙도 비교 (Infrastructure Maturity)

#### 15.4.1 인덱서 아키텍처 비교

| 시스템 | 인덱서 구현 | 데이터 소스 | 분리 수준 |
|--------|----------|----------|---------|
| dYdX v4 | 전용 Go 서비스 (Kafka 기반 이벤트 스트림) | 검증인 노드 소켓 스트림 | 완전 분리 (별도 프로세스/서버) |
| Hyperliquid | 자체 인덱서 (비공개) | HyperBFT 노드 내장 | 내장형 |
| Lighter | 자체 인덱서 (비공개) | zk-rollup 상태 루트 | 미공개 |
| Orderly | 별도 인덱싱 서비스 | OP Stack 이벤트 로그 | 완전 분리 |
| **HyperKRW** | **Ponder (TypeScript, PostgreSQL 기록)** | **HyperEVM 이벤트 로그 구독** | **별도 프로세스로 분리 (올바른 설계)** |

**평가:** Ponder 인덱서의 분리 아키텍처는 dYdX/Orderly 패턴과 일치한다. 읽기 전용 쿼리가 매칭 엔진과 독립적으로 작동하므로 조회 부하가 매칭 성능에 영향을 주지 않는다. 올바른 설계 결정이다.

#### 15.4.2 데이터 영속성 격차 — 핵심 위험

**전체 7개 경쟁사는 오더북 및 포지션 상태를 내구성 있는 저장소(데이터베이스/온체인)에 보관한다.** HyperKRW만이 인메모리 전용(`MemoryOrderBookStore`, `PositionTracker`) 구조를 사용한다.

| 상태 유형 | 경쟁사 처리 방식 | HyperKRW 현재 방식 | 재시작 시 결과 |
|---------|-------------|-----------------|------------|
| 오더북 (미체결 주문) | DB 또는 온체인 저장 | 메모리 전용 | 전체 소실 |
| 포지션 상태 | DB 또는 온체인 저장 | 메모리 전용 (PositionTracker) | 소실 (단, MarginRegistry 온체인 복구 가능) |
| 보험기금 잔액 | 온체인 또는 DB | 메모리 + 온체인 비동기 | InsuranceFundSyncer 재시작 후 과거 이벤트 누락 위험 |
| 청산 단계 추적 | DB | 메모리 (liquidationSteps Map) | 소실 (진행 중 청산 중단) |

**심각도:** 테스트넷에서는 허용 가능하나, 메인넷 배포 전 Redis(오더북/포지션 스냅샷) 또는 PostgreSQL 영속 레이어가 반드시 필요하다.

#### 15.4.3 단일 프로세스 위험 — 수평 확장 불가

| 시스템 | 수평 확장 방식 | 로드밸런싱 | 장애 조치(Failover) |
|--------|------------|----------|-----------------|
| dYdX v4 | 다중 검증인 노드 (CometBFT 자체 HA) | 합의 기반 내장 | 검증인 2/3 생존 시 자동 |
| Orderly | 멀티 인스턴스 시퀀서 설계 (문서화됨) | 별도 라우터 레이어 | 시퀀서 페일오버 |
| Vertex | 멀티 체인 Edge 배포 (독립 시퀀서 per 체인) | 체인별 분리 | 체인 독립 장애 격리 |
| Hyperliquid | 단일 글로벌 오더북 (HyperBFT 자체 HA) | 합의 내장 | 검증인 2/3 생존 시 자동 |
| **HyperKRW** | **단일 Node.js 프로세스** | **없음** | **없음 (재시작 = 상태 소실)** |

**OOM/프로세스 크래시 시나리오:** Node.js 힙 한계(기본 약 1.5GB) 도달 또는 `uncaughtException` 발생 시 전체 오더북과 포지션이 소실된다. Orderly와 Vertex는 시퀀서를 상태 비저장(stateless) 설계로 구현하거나 상태를 외부 저장소에 위임한다 — HyperKRW가 중기 로드맵에서 참고해야 할 패턴이다.

---

### 15.5 HyperKRW 강점 분석 (Strengths vs Competitors)

#### 15.5.1 STP 3-mode: EXPIRE_TAKER / EXPIRE_MAKER / EXPIRE_BOTH

경쟁사 중 STP를 공개 문서에서 동일 수준으로 지원하는 시스템:

| 시스템 | STP 지원 | 모드 수 |
|--------|--------|------|
| Paradex | EXPIRE_TAKER / EXPIRE_MAKER / EXPIRE_BOTH | 3 (동일) |
| Lighter | 메이커 주문 취소만 지원 | 1 |
| dYdX v4 | 프로토콜 수준 미문서화 | 미확인 |
| Hyperliquid | 미문서화 | 미확인 |
| Orderly | 미문서화 | 미확인 |
| Vertex | 미문서화 | 미확인 |
| **HyperKRW** | **완전 구현 (OrderBook.ts STP 분기 완전 테스트)** | **3** |

HyperKRW는 마켓 메이커가 자기 주문과 실수로 체결되는 상황을 3가지 전략으로 제어할 수 있는 유일한 시스템(Paradex와 공동)이다. 기관 유동성 공급자 유치에 있어 차별화 요소가 된다.

#### 15.5.2 TimelockController 48h + GUARDIAN 비대칭: 보안 거버넌스 우위

- Hyperliquid: 검증인 집합이 팀 주도 업그레이드를 즉시 적용 가능. 타임락 없음.
- Vertex, Orderly: 멀티시그 즉시 실행 가능. 타임락 없음.
- HyperKRW: 업그레이드 → Gnosis Safe 2/3 서명 → TimelockController 48h 대기 → 실행. 48시간 내 커뮤니티/감사자가 악의적 업그레이드를 탐지하고 GUARDIAN이 pause로 대응 가능.

#### 15.5.3 IComplianceModule 핫스왑: 규제 대응 유연성

2026년 한국 디지털자산기본법(DABA) 2단계 입법이 진행 중이다. VASP 분류체계, 사업자별 업무 범위, 공시 의무가 법제화될 예정이다. `IComplianceModule` 인터페이스를 통해 규제 변경 시 새 컨트랙트 배포 없이 컴플라이언스 로직을 교체할 수 있다 — 경쟁사 대비 규제 대응 비용이 현저히 낮다.

#### 15.5.4 HashiCorp Vault AppRole: 오퍼레이터 키 보안

HyperKRW 서버는 OPERATOR_ROLE 개인키를 직접 환경변수로 보유하지 않는다. Vault AppRole의 `role_id`/`secret_id` 조합으로 런타임에 키를 획득하며, `secret_id`는 단기 TTL과 사용 횟수 제한이 가능하다. 경쟁사 오픈소스 코드에서 동등한 구현이 확인되지 않는다.

#### 15.5.5 bigint 전용 재무 수학: KRW 가격 규모 대응

- 1 ETH ≈ 4,000,000 KRW
- 10배 레버리지 포지션 10 ETH의 명목금액 = 400,000,000 KRW
- `Number` 타입 안전 정수 한계: 2^53 ≈ 9,007,199,254,740,992 (~9×10^15)
- 계산 경로: `notional × rateScaled × timeScaled`에서 중간값이 10^36 이상 가능 — `Number`로는 절대 불가
- HyperKRW 전체 서버 코드베이스가 `bigint` 전용이며, `Number()`는 표시용으로만 사용된다 (SUG-6의 `computeRate()` 예외가 잔존)

#### 15.5.6 EIP-712 + Bitmap Nonce: Seaport 패턴 재사용 방지

- 비트맵 논스 (`nonceBitmap[user][wordIndex]`)는 비순차적 주문 취소를 O(1) 가스로 허용
- 한 번 체결/취소된 주문은 동일 서명으로 재제출 불가 (재사용 방지)
- 오퍼레이터가 빈 taker 서명으로 결제 가능한 구조는 의도적 설계 (오퍼레이터 신뢰 가정) — NatSpec 명시 권장

#### 15.5.7 KRW 특화 설계: 국내 시장 고유 기능

- `HybridPool.sol`: Curve StableSwap 2-pool로 KRW-스테이블코인 슬리피지 최소화
- `OracleAdmin.sol`: 2시간 타임락 + 델타 가드로 KRW/USD 환율 급변 시 조작 방지
- 김치 프리미엄을 indexPrice에 자연 반영하는 마크 가격 구조
- 원화 기준 margin cap 설정 가능 (외화 DEX 대비 규제 친화적)

---

### 15.6 HyperKRW 격차 분석 (Gap Analysis)

#### 15.6.1 Critical — 테스트넷 배포 전 필수 수정

**IMP-8: MarginAccount + PositionTracker 이중 상태**

`MarginAccount.ts`와 `PositionTracker.ts`가 각각 독립적인 포지션 상태를 유지한다. `LiquidationEngine.checkPositions()`는 `PositionTracker.getAll()`을 호출하는데, 이 메서드가 `margin: 0n`을 반환하여 모든 포지션이 즉시 청산 대상으로 판정된다. taker 포지션이 `PositionTracker`에 기록되지 않으므로 taker는 청산 시스템에서 완전히 보이지 않는다. 모든 7개 경쟁사는 단일 통합 포지션 저장소를 사용한다.

**IMP-4: LiquidationEngine 청산 주문 price=0n**

오프체인 매칭에서는 시장가로 처리되지만, 온체인 `OrderSettlement.settleLiquidation()`에 전달될 때 `price=0`이면 `quoteAmount = baseAmount × 0 / PRICE_SCALE = 0`이 되어 실제 토큰 이동이 없다. 온체인 청산이 명목상만 실행되고 자산 이동이 전혀 없는 심각한 버그이다.

**SUG-1: OracleAdmin 마크 가격 스탈니스 체크 없음**

`getMarkPrice()`가 timestamp를 반환하지만 stale 체크 로직이 없다. 오라클이 장시간 중단되어도 청산 엔진이 마지막 게시 가격을 계속 사용한다. `maxStaleness` 파라미터 추가 및 `require(block.timestamp - timestamp <= maxStaleness, "Stale price")` 가드가 필요하다.

#### 15.6.2 Pre-Mainnet — 메인넷 전 필수

| 항목 | 현황 | 필요 작업 |
|------|------|---------|
| 오더북/포지션 영속성 | 메모리 전용 (MemoryOrderBookStore) | Redis AOF 또는 PostgreSQL 기반 IOrderBookStore 구현체 |
| 단일 프로세스 | 클러스터링 없음 | PM2 cluster 또는 k8s horizontal pod autoscaling |
| 온/오프체인 상태 분기 | SettlementWorker 실패 시 자동 조정 없음 | 주기적 MarginRegistry 온체인 조회 → PositionTracker 보정 루프 |
| InsuranceFundSyncer 초기화 | 재시작 전 이벤트 누락 | 시작 시 과거 블록 범위 이벤트 일괄 처리 |
| MockERC20 import in Deploy.s.sol | 프로덕션 스크립트에 테스트 목 포함 | 테스트넷/프로덕션 배포 스크립트 분리 |

#### 15.6.3 Audit Recommended — 감사 권장

| 항목 | 위험 | 설명 |
|------|------|------|
| 오라클 키 중앙화 | 중간 | 단일 OPERATOR_ROLE이 mark price 게시. ±20% 델타 가드가 1차 방어선 |
| settleADL() 자금 미분배 | 중간 | 수집된 quote 토큰이 OrderSettlement에 잠김 (CR-3 수정 상태 검증 필요) |
| SUG-6: computeRate() Number() | 낮음-중간 | KRW 가격 범위에서 2^53 초과 가능. bigint rateScaled 반환으로 수정 |
| takerSig 미검증 경로 | 설계 의도 | 오퍼레이터 신뢰 가정이지만 NatSpec에 명시 필요 |
| SIGINT 핸들러 미등록 | 낮음 | liquidationInterval이 Ctrl+C 종료 시 미정리 |

#### 15.6.4 Long-term Roadmap — 장기 로드맵

| 기능 | 참조 경쟁사 | 우선순위 |
|------|----------|--------|
| TWAP/Scale 주문 | dYdX v4, Hyperliquid, Lighter | P3 |
| 포트폴리오 마진 | Paradex (2026 예정), Vertex | P3 |
| Dead Man's Switch | Hyperliquid (Agent Wallet 연동) | P2 |
| 멀티체인 입금 | Orderly (LayerZero 패턴) | P3 |
| 분산 청산자 퍼블릭 진입점 | Orderly (OrderSettlement.sol 패턴) | P2 |
| KRW 멀티소스 오라클 | Upbit + Bithumb + Binance × KRW/USD 환율 | P2 |
| Agent Wallet 서브키 | Hyperliquid 방식 | P2 |

---

### 15.7 테스트넷 준비도 점수 (Pre-Testnet Readiness Score)

| 평가 영역 | 점수 | 근거 | 남은 P0 작업 |
|---------|------|------|------------|
| CLOB 매칭 엔진 | **9/10** | Price-time priority, 7개 주문 유형, STP 3-mode 완전 구현. 단일 프로세스 한계만 존재 | 없음 |
| 마진 시스템 | **5/10** | MarginAccount cross/isolated 구현됨. IMP-8: 이중 상태로 단일 진실 소스 없음. taker 포지션 미추적 | IMP-8 통합 |
| 청산/ADL | **6/10** | ADL effectiveLeverage 랭킹 구현됨. IMP-4(price=0n)로 온체인 청산 결제 불가. 실전 미검증 | IMP-4 수정 |
| 펀딩 레이트 | **8/10** | ±4%/h cap bigint 구현, hourly settlement 온체인 연결됨. SUG-6 Number() 정밀도 위험 잔존 | SUG-6 수정 권장 |
| 오라클/마크가격 | **6/10** | P1/P2/midPrice 중앙값 구현 (Orderly 패턴). SUG-1 스탈니스 체크 없음. 오라클 키 중앙화 | SUG-1 추가 |
| 스마트컨트랙트 | **8/10** | UUPS + CEI + SafeERC20 일관 적용. settleADL() 미분배 버그. MockERC20 스크립트 혼재 | CR-3 검증 |
| 보안 인프라 | **8/10** | Vault AppRole + Gnosis Safe 2/3 + Timelock 48h. GUARDIAN 비대칭 설계 우수 | 없음 |
| API/WebSocket | **8/10** | OpenAPI/Swagger 완전 문서화. WebSocket markprice/funding/position. Rate limiting 구현 | 없음 |
| 컴플라이언스 | **9/10** | IComplianceModule 핫스왑, OFAC SDN, Chainalysis API 선택적 통합. 한국 규제 대응 가능 | 없음 |
| 인프라/운영 | **4/10** | Docker Compose + Traefik + Ponder 구성됨. 메모리 전용 상태. 모니터링(Prometheus/Grafana) 없음 | 없음 (P1) |

**종합 평균: 7.1/10**

**최종 판정: 테스트넷 배포 조건부 준비 완료**

> IMP-8, IMP-4, SUG-1 수정 완료 후 테스트넷 배포 권장. 3개 이슈 수정 후 예상 점수 8.2/10.
> 메인넷 전 영속 저장소 + 모니터링 추가 필수.

---

### 15.8 경쟁사별 즉시 적용 가능 패턴 (Actionable Learnings per Competitor)

#### dYdX v4 → HyperKRW 적용

**Short-Term Order TTL 자동 만료 통보:**
dYdX v4 Short-Term Order는 20블록(~30초) 유효 후 자동 만료된다. HyperKRW GTT 주문은 만료 후 제거가 구현되어 있지만, 서버 재시작 시 만료되지 않은 주문이 모두 소실된다. 최소한 재시작 후 모든 미체결 주문을 "expired" 처리하고 WebSocket을 통해 클라이언트에 통보하는 로직이 필요하다.

**읽기 전용 인덱서 완전 분리 (이미 올바르게 구현됨):**
dYdX v4의 인덱서는 검증인 노드와 완전히 다른 프로세스에서 Kafka를 통해 이벤트를 수신한다. HyperKRW Ponder는 이미 별도 프로세스로 분리되어 있어 이 패턴을 올바르게 따르고 있다.

#### Hyperliquid → HyperKRW 적용

**Agent Wallet 서브키 위임:**
Hyperliquid의 Agent Wallet은 트레이더가 메인 지갑을 노출하지 않고 서명 권한을 임시 서브키에 위임할 수 있다. HyperKRW에서 `OrderSettlement.sol`에 `approveAgent(address agent, uint256 expiry)` 패턴을 추가하면 API 트레이더가 메인 지갑을 직접 사용하지 않아도 된다. 알고리즘 트레이딩 봇 운영에 특히 유리하다.

**Dead Man's Switch:**
Hyperliquid는 트레이더가 특정 시간 내 취소 명령이 없으면 모든 주문을 자동 취소하는 Dead Man's Switch를 지원한다. HyperKRW `GTT` 주문 로직을 확장하여 `scheduledCancelAfter` 필드를 추가하면 별도 컨트랙트 변경 없이 서버 사이드로 구현 가능하다.

#### Paradex → HyperKRW 적용

**사회화 손실 계수 (Socialized Loss Factor):**
Paradex는 보험기금 고갈 시 전체 트레이더에게 손실을 사회화하는 계수를 서버 사이드 회계 조정으로 처리한다. HyperKRW `InsuranceFund.cover()`의 `InsuranceFundExhausted` 이벤트 발생 시 `PositionTracker` 레벨에서 사회화 계수를 적용하는 로직을 추가할 수 있다 — 컨트랙트 변경 없이 서버 사이드로 구현 가능.

#### Orderly → HyperKRW 적용

**브로커 수수료 레이어:**
Orderly는 `PairRegistry`에 `brokerFeeRate`와 `brokerFeeAddress`를 등록하여 브로커(프론트엔드 운영자)가 수수료의 일부를 수취한다. HyperKRW `PairRegistry.sol`에 `brokerFeeRate` 파라미터를 추가하고 `FeeCollector.sol`에서 브로커 주소로 분배하면 유통 구조를 다변화할 수 있다. 예상 공수: 0.5일.

**분산 청산자 퍼블릭 진입점 (Orderly 패턴):**
Orderly는 `OrderSettlement.sol`에 누구나 청산을 제출할 수 있는 퍼블릭 청산 함수를 제공하며, 청산자는 청산 수수료의 일부를 인센티브로 받는다. HyperKRW의 청산은 현재 OPERATOR_ROLE 전용이다. 퍼블릭 청산 진입점을 추가하면 단일 프로세스 장애 시에도 외부 봇이 청산을 수행할 수 있어 시스템 안전성이 향상된다.

#### Lighter → HyperKRW 적용

**오더북 상태 루트 온체인 커밋 (단순화 버전):**
Lighter는 zk-proof로 모든 매칭을 검증하지만, 그보다 간단한 방식을 참고할 수 있다: 주기적으로 오더북 스냅샷의 `keccak256` 해시를 이벤트로 온체인에 기록한다. 감사자가 언제든 오프체인 오더북과 온체인 체크포인트를 비교할 수 있어 신뢰성이 향상된다. 컨트랙트 변경 최소, 서버 사이드 주기 태스크 추가로 구현 가능.

#### Vertex → HyperKRW 적용

**Spot + Perp 통합 마진 (장기 로드맵):**
Vertex는 HybridPool(Spot AMM)과 Perp 포지션의 마진을 통합하여 자본 효율을 높인다. HyperKRW는 이미 `HybridPool.sol`과 `MarginRegistry.sol`이 분리되어 있다. `IComplianceModule`과 유사한 인터페이스(`ICollateralModule`)를 추가하여 HybridPool LP 포지션을 마진 담보로 인식하는 구조를 중기 로드맵에 포함할 수 있다.

---

### 15.9 2026년 DEX 트렌드 대비 포지셔닝 (2026 Trends Positioning)

#### T1: 완전 온체인 오더북의 부상 (Full On-Chain CLOB Gaining Ground)

Hyperliquid는 200,000 주문/초, 오픈 인터레스트 95.7억 달러(2026년 2월 기준), 주간 거래량 400억 달러 이상으로 탈중앙화 퍼프 DEX 시장의 약 32%를 점유한다. 탈중앙화 퍼프 DEX 전체는 2025년 말 기준 글로벌 선물 거래량의 26%를 처리하고 있으며, 월간 합산 거래량이 1.2조 달러를 초과했다. HyperBFT의 one-block finality가 완전 온체인 오더북을 경제적으로 실현 가능하게 만들었다.

**HyperKRW 포지셔닝:** 오프체인 CLOB은 HyperEVM의 패스트 블록(1초, 2M 가스) 한계를 고려한 의도적 트레이드오프이다. EIP-712 서명 구조는 미래에 HyperCore(완전 온체인) 마이그레이션과 호환성이 있다 — 서명 스킴과 비트맵 논스는 온체인 오더북에서도 그대로 재사용 가능하다.

#### T2: 크로스체인 유동성 (Cross-Chain Liquidity)

Vertex Edge는 6개 체인(Arbitrum, Sei, Sonic, Botanix, Berachain, 기타)에 걸쳐 통합 오더북을 제공하며 40개 체인까지 확장 예정이다. Orderly는 LayerZero로 멀티체인 입금을 지원한다. Hyperliquid는 단일 글로벌 오더북으로 맞대응한다.

**HyperKRW 포지셔닝:** 단일 HyperEVM 체인 설계는 의도적 선택이다. KRW 스테이블코인은 현재 ETH 생태계 외부의 크로스체인 인프라가 부족하며, Orderly LayerZero 패턴의 멀티체인 입금은 중기 로드맵(P3) 항목이다.

#### T3: 기관 컴플라이언스 테이블스테이크화 (Institutional Compliance as Table-Stakes)

한국 가상자산이용자보호법은 2024년 7월 시행되었으며, 2026년에는 디지털자산기본법(DABA) 2단계가 추진 중이다. FSC는 2026년 3월 4일 가상자산위원회 첫 회의를 개최했다. 핵심 내용: VASP 분류, 사업자별 업무 범위, 공시 의무, ICO 재허용 등이다. 스테이블코인 발행 주체 논쟁(은행 51% 의무 vs. 핀테크 진입 허용)이 지속 중이다.

**DEX에 대한 직접적 규제 조항은 2026-04-06 기준 명문화되지 않았으나**, VASP 분류 시 DEX 운영자도 등록 의무 대상이 될 수 있다. HyperKRW의 `IComplianceModule` 핫스왑 설계는 이런 규제 불확실성에 대응하는 사전 포지셔닝이다.

#### T4: 네이티브 토큰 유동성 부스트 (Native Token as Growth Engine)

- HYPE(Hyperliquid): 시총 상위권. 거래 수수료의 유의미한 비율이 HYPE 바이백에 사용됨.
- DYDX(dYdX v4): 75% 순 프로토콜 수익을 DYDX 바이백에 할당 (2026년 거버넌스 결의).
- VRTX(Vertex): 멀티체인 확장과 연동된 스테이킹 인센티브.
- DIME(Paradex): 2026년 3월 genesis airdrop (공급의 25% 커뮤니티 할당).

**HyperKRW 포지셔닝:** 토큰 미발행은 의도적 결정이다. 토큰 없이 유동성을 부트스트랩하려면 (a) 마켓 메이커 인센티브 협약, (b) KRW 스테이블코인 고유 수요 창출, (c) 한국 규제 환경 내 합법적 토큰 발행 경로 확보가 선행되어야 한다. 토큰 발행 전 컴플라이언스 인프라가 먼저 갖춰진 점은 장기적으로 유리하다.

#### T5: ZK-proof 확장 (ZK-Proof Expanding)

Lighter: 모든 매칭과 청산을 zk-SNARK로 증명. 2025년 10월 퍼블릭 메인넷 오픈. TVL 14.4억 달러, 오픈 인터레스트 15.3억 달러, 30일 거래량 2,322억 달러(2025년 12월 기준).
Paradex: StarkNet ZK-rollup. TVL 최고 2.18억 달러(2026년 1월).

**HyperKRW 포지셔닝:** ZK-proof 통합은 HyperEVM 자체의 ZK 지원 로드맵에 의존한다. 현재 HyperEVM은 Cancun 포크(블롭 제외) 수준으로 ZK-proof 네이티브 지원이 없다. 매칭 정확성 증명보다는 오더북 상태 루트 주기 커밋(Lighter 패턴의 단순화 버전)이 현실적 단기 대안이다.

#### T6: HyperEVM 기반 DeFi 생태계 성장

HyperEVM 패스트 블록(1초, 2M 가스)과 슬로우 블록(1분, 30M 가스)의 이중 구조는 HyperKRW에 직접적인 의미를 가진다:

- `settleLiquidation()` 호출은 패스트 블록(1초, 2M 가스)으로 충분히 처리 가능 — 청산 레이턴시 최소화
- 대량 배치 결제 `settle()`은 슬로우 블록(1분, 30M 가스)을 활용 — 가스 비용 절감
- EIP-1559 활성화: 패스트 블록 기본 수수료 1 gwei, 슬로우 블록 0.5 gwei. HyperKRW는 HYPE를 가스로 보유해야 한다.
- HyperEVM과 HyperCore의 상호운용을 통해 HyperCore의 HYPE 네이티브 유동성과 연동할 경우 유동성 시너지 가능

---

### 15.10 권장 다음 단계 (Recommended Next Steps)

#### P0 — 테스트넷 배포 전 필수

| 우선순위 | 이슈 ID | 작업 | 컴포넌트 | 예상 공수 |
|--------|--------|------|---------|--------|
| P0-1 | IMP-8 | MarginAccount.ts + PositionTracker.ts 단일 상태 통합. `getAll()`이 실제 margin 반환. taker 포지션 추적 추가 | krw-dex-server | 2일 |
| P0-2 | IMP-4 | `LiquidationEngine.ts` 청산 주문 `price: 0n` → markPrice 사용으로 수정. `MarkPriceOracle.getMarkPrice(pairId)` 호출 추가 | krw-dex-server | 반나절 |
| P0-3 | SUG-1 | `OracleAdmin.sol`에 `maxStaleness` 파라미터 추가. `require(block.timestamp - timestamp <= maxStaleness)` 가드 추가 | krw-dex-contracts | 반나절 |
| P0-4 | SUG-6 | `FundingRateEngine.ts` `computeRate()`의 `Number()` 패턴을 bigint `rateScaled` 계산으로 교체 | krw-dex-server | 1시간 |

#### P1 — 테스트넷 직후

| 우선순위 | 작업 | 컴포넌트 | 예상 공수 |
|--------|------|---------|--------|
| P1-1 | Redis 기반 오더북/포지션 영속성. `IOrderBookStore` 인터페이스의 Redis 구현체 추가 | krw-dex-server | 3일 |
| P1-2 | `InsuranceFundSyncer` 시작 시 과거 이벤트 일괄 처리 (blockRange replay) | krw-dex-server | 1일 |
| P1-3 | Prometheus + Grafana 모니터링 스택 추가 (Docker Compose). 핵심 메트릭: 매칭 레이턴시, 청산 횟수, 보험기금 잔액, WebSocket 연결 수 | 인프라 | 1일 |
| P1-4 | `HybridPool.sol` decimal 정규화 수정 (CR-5). 6-decimal USDC/USDT + 18-decimal KRW 스테이블코인 `rates[]` 배열 추가 | krw-dex-contracts | 1일 |
| P1-5 | 테스트넷/프로덕션 배포 스크립트 분리 (`Deploy.s.sol`에서 `MockERC20` import 제거) | krw-dex-contracts | 반나절 |

#### P2 — 메인넷 전

| 우선순위 | 작업 | 컴포넌트 | 예상 공수 |
|--------|------|---------|--------|
| P2-1 | 독립적 보안 감사 (선정 기준: Solidity 전문 감사 기관, EIP-712/UUPS 경험) | 외부 | 4-8주 |
| P2-2 | Orderly 패턴 분산 청산자 퍼블릭 진입점 추가 | krw-dex-contracts | 1주 |
| P2-3 | Hyperliquid Agent Wallet 패턴: `approveAgent(agent, expiry)` 온체인 위임 | krw-dex-contracts | 1주 |
| P2-4 | 브로커 수수료 레이어: `PairRegistry.sol`에 `brokerFeeRate` + `FeeCollector.sol` 브로커 분배 | krw-dex-contracts + server | 0.5주 |
| P2-5 | Dead Man's Switch: GTT 주문 `scheduledCancelAfter` 필드 + 서버 사이드 자동 취소 | krw-dex-server | 0.5주 |
| P2-6 | KRW 멀티소스 오라클: Upbit + Bithumb + Binance × KRW/USD 환율 가중 평균 | krw-dex-server | 1주 |

---

### 15.11 출처 (Sources — Section 15 추가분)

| 번호 | 출처 | URL | 접근일 |
|-----|------|-----|------|
| S15-1 | Hyperliquid Docs — HyperEVM Dual-Block Architecture | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture | 2026-04-06 |
| S15-2 | Hyperliquid Docs — HyperEVM Overview | https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm | 2026-04-06 |
| S15-3 | BlockEden.xyz — The Perp DEX Wars of 2026 | https://blockeden.xyz/blog/2026/01/29/perp-dex-wars-2026-hyperliquid-lighter-aster-edgex-paradex-decentralized-derivatives/ | 2026-04-06 |
| S15-4 | WuBlock — Hyperliquid ADL Event (October 2025) | https://wublock.substack.com/p/hyperliquid-activates-cross-margin | 2026-04-06 |
| S15-5 | ZeroHedge — After October Liquidation Day Collapse | https://www.zerohedge.com/crypto/after-octobers-liquidation-day-collapse-adl-are-3-most-important-letters-crypto | 2026-04-06 |
| S15-6 | Lighter Mainnet Launch — Blockworks | https://blockworks.com/news/lighter-opens-public-mainnet | 2026-04-06 |
| S15-7 | Bitcoin.com — What is Lighter (2026 Guide) | https://www.bitcoin.com/get-started/what-is-lighter-ethereum-perp-dex/ | 2026-04-06 |
| S15-8 | DefiLlama — Hyperliquid TVL/Volume | https://defillama.com/protocol/hyperliquid | 2026-04-06 |
| S15-9 | CryptoRank — South Korea FSC Digital Asset Act 2026 | https://cryptorank.io/news/feed/5ffd1-south-korea-fsc-digital-asset-act | 2026-04-06 |
| S15-10 | 법률신문 — 2026년 대한민국 가상자산산업 10대 핵심 이슈 | https://www.lawtimes.co.kr/LawFirm-NewsLetter/215219 | 2026-04-06 |
| S15-11 | Paradex Review 2026 — Decentralised.news | https://decentralised.news/paradex-review-2026-starknet-appchain-perp-dex | 2026-04-06 |
| S15-12 | MEXC — Paradex In-Depth Report (TGE, DIME Token) | https://www.mexc.com/news/786520 | 2026-04-06 |
| S15-13 | Vertex Protocol — Multi-Chain Edge Expansion | https://coinmarketcap.com/academy/article/what-is-vertex | 2026-04-06 |
| S15-14 | dYdX 2026 Roadmap — Coin Bureau | https://coinbureau.com/review/dydx | 2026-04-06 |
| S15-15 | Solidus Labs — $20B Crypto Crash Liquidation Analysis | https://www.soliduslabs.com/post/when-whales-whisper-inside-the-20-billion-crypto-meltdown | 2026-04-06 |

---

*섹션 15 작성: 2026년 4월 6일. HyperKRW 세션 3 완료 이후 상태 (krw-dex-server d9a33f9, krw-dex-contracts 1fa6d80) 기준. 웹 리서치 기준일 동일.*
