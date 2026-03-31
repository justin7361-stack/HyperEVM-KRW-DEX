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

*이 문서는 2026년 3월 31일 기준으로 각 DEX의 공개 문서, GitHub 레포지토리, 공식 API 문서를 기반으로 작성되었습니다. 각 프로토콜은 지속적으로 업데이트되므로, 구체적인 구현 전에 최신 공식 문서를 반드시 확인하세요.*
