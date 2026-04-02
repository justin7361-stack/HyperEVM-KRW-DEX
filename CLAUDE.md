# HyperKRW — CLAUDE.md

This is the **HyperKRW** project: a CLOB DEX built on HyperEVM (Hyperliquid L1) with KRW stablecoin as the base currency.

---

## 세션 규칙 (Session Rules)

### 세션 시작 시 반드시:
1. `docs/tmr_todo.md` 읽기 — 현재 태스크, 우선순위, 설계 결정사항 파악
2. `git log --oneline -10` 실행 — 최근 커밋 히스토리로 맥락 파악
3. GitHub 레포 전체 진행사항 확인 후 현재 상태 파악하고 시작

### 세션 종료 시 반드시:
1. `docs/tmr_todo.md` 업데이트:
   - 단순 할 일 목록이 아니라 **각 태스크의 설계 결정사항, 주의사항, 다음 세션에 알아야 할 것**까지 상세히 기록
   - 완료된 태스크는 커밋 해시와 함께 기록
   - 다음에 이어서 할 태스크 명확히 표시
2. 작업 내용 GitHub에 커밋/푸시

---

---

## Project Overview

- **Name:** HyperKRW
- **Chain:** HyperEVM (Hyperliquid L1 EVM layer)
- **Architecture:** Off-chain order matching + on-chain EIP-712 settlement
- **Contracts:** Solidity 0.8.24, Foundry, OpenZeppelin Contracts-Upgradeable v5
- **Repo:** https://github.com/justin7361-stack/HyperEVM-KRW-DEX

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
