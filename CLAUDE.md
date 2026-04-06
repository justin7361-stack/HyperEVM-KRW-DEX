# HyperKRW — CLAUDE.md

This is the **HyperKRW** project: a CLOB DEX built on HyperEVM (Hyperliquid L1) with KRW stablecoin as the base currency.

---

## 세션 규칙 (Session Rules)

### 세션 시작 시 반드시:
1. `docs/`의 **모든 `*_review.md` 파일** (`1st_review.md`, `2nd_review.md` 등)과 `docs/research.md`를 읽어 이전 리뷰 결과, 알려진 버그, 설계 결정 히스토리를 숙지
2. `docs/tmr_todo.md` 읽기 — 현재 태스크, 우선순위, 설계 결정사항 파악
3. `git log --oneline -10` 실행 — 최근 커밋 히스토리로 맥락 파악
4. GitHub 레포 전체 진행사항 확인 후 현재 상태 파악하고 시작
5. 새로운 todo 작성 시 반드시 review.md의 Critical/Important 이슈를 반영하여 우선순위 결정

### 세션 종료 시 반드시:
1. `docs/tmr_todo.md` 업데이트:
   - 단순 할 일 목록이 아니라 **각 태스크의 설계 결정사항, 주의사항, 다음 세션에 알아야 할 것**까지 상세히 기록
   - 완료된 태스크는 커밋 해시와 함께 기록
   - 다음에 이어서 할 태스크 명확히 표시
2. 작업 내용 GitHub에 커밋/푸시

---

## 컨텍스트 관리 규칙 (Context Management)

### 세션 분리 원칙
3개 레포(krw-dex-server / HyperEVM-KRW-DEX / krw-dex-web)를 동시에 다루면 컨텍스트가 빠르게 소모된다.
**레포 1개 = 세션 1개** 원칙을 기본으로 한다.

| 세션 유형 | 담당 레포/범위 | 예시 |
|---------|-------------|------|
| Contract 세션 | `HyperEVM-KRW-DEX` 단독 | Solidity 버그, 배포 스크립트 |
| Server 세션 | `krw-dex-server` 단독 | 버그 수정, 인프라, API 추가 |
| Frontend 세션 | `krw-dex-web` 단독 | UI 버그, 컴포넌트 추가 |
| Infra/Deploy 세션 | docker-compose, forge broadcast | Phase Q 배포 |

### 새 세션이 필요한 신호 (Claude가 알려줄 것)
Claude는 다음 상황 중 하나에 해당하면 **작업 완료 후 즉시** 사용자에게 알린다:
- 현재 대화가 compacting된 이력이 있고, 다음 태스크가 새 레포/도메인으로 전환될 때
- 현재 태스크가 완료되고 다음 Phase가 **완전히 다른 레포**를 주로 다룰 때
- 컨텍스트 소모가 많아 코드 품질에 영향을 줄 가능성이 보일 때

### tmr_todo.md가 세션 간 핵심 인수인계 수단
- compaction/새 세션 후에도 `tmr_todo.md`의 커밋 해시 + 설계 결정사항만 있으면 맥락 복원 가능
- 따라서 **종료 전 tmr_todo.md를 충분히 상세하게 쓰는 것이 최우선**

---

---

## Project Overview

- **Name:** HyperKRW
- **Chain:** HyperEVM (Hyperliquid L1 EVM layer)
- **Architecture:** Off-chain order matching + on-chain EIP-712 settlement
- **Contracts:** Solidity 0.8.24, Foundry, OpenZeppelin Contracts-Upgradeable v5
- **Repo:** https://github.com/justin7361-stack/HyperEVM-KRW-DEX

---

## 개발 철학 (Development Philosophy)

### 오픈소스 우선 원칙 (Open Source First)

**항상 상용화를 염두에 두고, 새 기능을 개발하기 전에 반드시 오픈소스를 먼저 비교 분석한다.**

#### 의사결정 순서
```
1. 기능 요구사항 정의
2. 동종 오픈소스 구현 조사 (dYdX v4, Hyperliquid, Orderly, Paradex, Curve, Uniswap 등)
3. 포킹 vs. 직접 구현 판단:
   ┌─ 포킹 우선 조건:
   │   - 검증된 수학 공식 (StableSwap, 청산 가격 등)
   │   - 보안 감사 받은 패턴 (CEI, ReentrancyGuard 적용 방식 등)
   │   - 업계 표준 인터페이스 (EIP-712, Chainlink AggregatorV3 등)
   │   - KRW 특화 수정이 최소인 경우
   └─ 직접 구현 조건:
       - KRW 기반 구조로 전면 수정이 필요한 경우
       - 오픈소스가 다른 언어/프레임워크라 변환 비용 > 직접 작성 비용
       - HyperKRW 고유 기능 (STP, 서버-컨트랙트 연동 등)
4. 포킹 시: 출처 명시, 변경 사항 문서화
5. 직접 작성 시: research.md의 참조 구현과 비교 검증
```

#### 주요 참조 오픈소스
| 컴포넌트 | 1차 참조 | 2차 참조 |
|---------|---------|---------|
| StableSwap AMM | [Curve 2-pool](https://github.com/curvefi/curve-contract) | [Uniswap v2 core](https://github.com/Uniswap/v2-core) |
| EIP-712 결제 | [Orderly EVM contracts](https://github.com/OrderlyNetwork/contract-evm) | [Seaport](https://github.com/ProjectOpenSea/seaport) |
| 펀딩 레이트 | [dYdX v4 perpetuals](https://github.com/dydxprotocol/v4-chain/tree/main/protocol/x/perpetuals) | Hyperliquid docs |
| 청산 엔진 | [dYdX v4 subaccounts](https://github.com/dydxprotocol/v4-chain/tree/main/protocol/x/subaccounts) | Paradex docs |
| 오라클 인터페이스 | [Chainlink AggregatorV3](https://github.com/smartcontractkit/chainlink) | Pyth SDK |
| UUPS 업그레이드 | [OZ UUPS pattern](https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable) | — |

---

## Coding Standards

### Solidity
- Follow existing contract patterns and naming conventions
- Use OpenZeppelin libraries where possible
- Maintain security best practices (CEI pattern, SafeERC20, ReentrancyGuard, UUPS proxy)
- Document complex functions with NatSpec (`@notice`, `@dev`, `@param`, `@return`)
- All contracts use UUPS proxy pattern with `_disableInitializers()` in constructor
- Do NOT call `__UUPSUpgradeable_init()` — it does not exist in OZ v5 (stateless)
- Cache role constants before `vm.prank` in Foundry tests to avoid staticcall consuming the prank

### Documentation
- Write clear, beginner-friendly explanations
- Use examples with realistic numbers (e.g., 1 USDC = 1350 KRW)
- Maintain consistent **HyperKRW** branding
- Follow established file structure

---

## Key Acknowledgments

This protocol is built on the **Hyperliquid L1 (HyperEVM)** foundation. Always acknowledge their pioneering work when making significant changes or additions.

---

## Testing Strategy

- Unit tests for individual contract functions
- Integration tests for cross-contract interactions
- Fuzz tests for arithmetic-heavy functions (oracle delta, StableSwap math)
- Documentation should include practical examples
- Test mobile responsiveness for docs site

---

## Deployment Notes

- Use deterministic deployment addresses where possible
- Maintain deployment scripts in `/script/deployments/`
- Document all deployment parameters
- Test on testnets before mainnet deployment
- **Production deployer must renounce admin roles after setup** (do not leave deployer with DEFAULT_ADMIN_ROLE)

---

## Support Commands

When working with this codebase, prefer these approaches:

### File Operations
- Use `Read` tool for examining contracts
- Use `Glob` tool for finding files by pattern
- Use `Grep` tool for searching code content

### Development
- Run `forge build` and `forge test` to verify contract changes
- Run `cd docs && npm start` to preview documentation changes
- Check `git status` before committing changes

---

## Common Patterns

### Contract Deployment
1. Create deployment script in `/script/deployments/`
2. Test on local fork first
3. Deploy to testnet
4. Deploy to mainnet with verified contracts

### Documentation Updates
1. Update relevant `.md` files in `/docs/docs/`
2. Test locally with `npm start`
3. Commit changes with descriptive messages
4. Build and deploy documentation site

---

## Security Considerations

- All contracts handle user funds — **security is paramount**
- Use established patterns from OpenZeppelin and Jarvis Protocol
- Implement proper access controls (DEFAULT_ADMIN_ROLE, OPERATOR_ROLE, GUARDIAN_ROLE)
- Consider economic attack vectors:
  - Oracle manipulation (KRW rate manipulation via OracleAdmin)
  - Front-running (mitigated by off-chain matching + on-chain settlement)
  - Flash loan attacks (`lastLiquidityChangeBlock` pool-wide guard in HybridPool)
  - Signature replay (EIP-712 bitmap nonces in OrderSettlement)
  - Share inflation attacks (MINIMUM_LIQUIDITY permanently locked)
- Test edge cases thoroughly
- GUARDIAN role: pause-only (cannot unpause — deliberate asymmetry)

---

## Contract Architecture

```
src/
├── interfaces/
│   └── IComplianceModule.sol   # Compliance interface (swappable)
├── PairRegistry.sol            # Token whitelist + pair management
├── OracleAdmin.sol             # KRW rate oracle (timelock + delta guard)
├── BasicCompliance.sol         # Blocklist + geo-block compliance
├── FeeCollector.sol            # Fee accumulation and withdrawal
├── OrderSettlement.sol         # EIP-712 CLOB settlement (bitmap nonces)
└── HybridPool.sol              # Curve StableSwap + oracle fallback
```
