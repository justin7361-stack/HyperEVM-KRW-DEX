# HyperKRW Server — CLAUDE.md

This is the **HyperKRW DEX Server**: off-chain CLOB matching engine for the HyperKRW DEX built on HyperEVM.

- **Repo:** https://github.com/justin7361-stack/krw-dex-server
- **Stack:** TypeScript, Node.js, Fastify, Vitest
- **Companion contracts repo:** https://github.com/justin7361-stack/HyperEVM-KRW-DEX

---

## 세션 규칙 (Session Rules)

### 세션 시작 시 반드시:
1. `docs/tmr_todo.md` (또는 컨트랙트 레포의 `docs/tmr_todo.md`) 읽기 — 현재 태스크, 우선순위, 설계 결정사항 파악
2. `git log --oneline -10` 실행 — 최근 커밋 히스토리로 맥락 파악
3. GitHub 레포 전체 진행사항 확인 후 현재 상태 파악하고 시작

### 세션 종료 시 반드시:
1. `docs/tmr_todo.md` 업데이트:
   - 단순 할 일 목록이 아니라 **각 태스크의 설계 결정사항, 주의사항, 다음 세션에 알아야 할 것**까지 상세히 기록
   - 완료된 태스크는 커밋 해시와 함께 기록
   - 다음에 이어서 할 태스크 명확히 표시
2. 작업 내용 GitHub에 커밋/푸시

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
