// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * DeployTestnet — Q-2: All-in-one testnet deployment script.
 *
 * Combines Deploy.s.sol + Config.s.sol + testnet setup into a single
 * broadcast so you only need one forge script command.
 *
 * What it does:
 *   1.  Deploy MockKRW (18 dec) + MockUSDC (6 dec) ERC-20s
 *   2.  Deploy all 7 protocol contracts (PairRegistry → MarginRegistry)
 *   3.  Deploy HybridPool KRW/USDC
 *   4.  Run post-deploy config (roles, fees, oracle rates)
 *   5.  Whitelist MockUSDC as a base token
 *   6.  Register USDC/KRW trading pair with sensible testnet parameters
 *   7.  Mint test tokens to deployer (for E2E testing)
 *   8.  Print all addresses in .env-ready format
 *
 * Usage:
 *   cp .env.testnet.example .env.testnet
 *   source .env.testnet
 *
 *   # Dry run (recommended first)
 *   forge script script/DeployTestnet.s.sol \
 *     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm
 *
 *   # Deploy
 *   forge script script/DeployTestnet.s.sol \
 *     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
 *     --broadcast
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — deploys + funds deployer with test tokens
 *   OPERATOR_ADDRESS       — server wallet (gets OPERATOR_ROLE)
 *   GUARDIAN_ADDRESS       — emergency pause wallet (gets GUARDIAN_ROLE)
 *
 * Optional env vars:
 *   USDC_ADDRESS           — skip MockUSDC deployment (use real testnet USDC)
 */

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/PairRegistry.sol";
import "../src/OracleAdmin.sol";
import "../src/BasicCompliance.sol";
import "../src/FeeCollector.sol";
import "../src/OrderSettlement.sol";
import "../src/InsuranceFund.sol";
import "../src/MarginRegistry.sol";
import "../src/HybridPool.sol";
import "../test/mocks/MockERC20.sol";

contract DeployTestnet is Script {
    uint256 constant INITIAL_RATE    = 1350e18;       // 1 USDC = 1350 KRW (18 dec)
    uint256 constant TICK_SIZE       = 1e16;           // 0.01 KRW in wei
    uint256 constant LOT_SIZE        = 1e15;           // 0.001 KRW equivalent
    uint256 constant MIN_ORDER_SIZE  = 1350e18;        // ~1 USDC worth of KRW
    uint256 constant MAX_ORDER_SIZE  = 1_350_000e18;   // ~1M USDC worth of KRW
    uint256 constant MINT_KRW        = 10_000_000e18;  // 10M KRW
    uint256 constant MINT_USDC       = 10_000e6;       // 10K USDC (6 dec)

    /// @dev Groups all deployed addresses to avoid stack-too-deep in run().
    struct Deployed {
        address settlement;
        address registry;
        address oracle;
        address feeCollector;
        address insuranceFund;
        address marginRegistry;
        address pool;
    }

    function run() external {
        uint256 deployerKey  = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer     = vm.addr(deployerKey);
        address operator     = vm.envAddress("OPERATOR_ADDRESS");
        address guardian     = vm.envAddress("GUARDIAN_ADDRESS");
        address existingUsdc = vm.envOr("USDC_ADDRESS", address(0));
        address admin        = deployer; // testnet: deployer = admin

        vm.startBroadcast(deployerKey);

        (address krwAddr, address usdcAddr) = _deployTokens(existingUsdc);
        Deployed memory d = _deployCore(admin, operator, guardian, krwAddr, usdcAddr);
        _configure(d, operator, usdcAddr);
        _mintTestTokens(krwAddr, usdcAddr, deployer, operator, existingUsdc);

        vm.stopBroadcast();

        _printEnv(d, krwAddr, usdcAddr);
    }

    // ── Step 1: Deploy mock tokens ────────────────────────────────────────────

    function _deployTokens(address existingUsdc) internal returns (address krwAddr, address usdcAddr) {
        krwAddr = address(new MockERC20("HyperKRW Stablecoin", "KRWS", 18));
        console.log("=== TOKEN ADDRESSES ===");
        console.log("MockKRW  (KRWS, 18 dec):", krwAddr);

        if (existingUsdc == address(0)) {
            usdcAddr = address(new MockERC20("USD Coin", "USDC", 6));
            console.log("MockUSDC (USDC,  6 dec):", usdcAddr);
        } else {
            usdcAddr = existingUsdc;
            console.log("Using existing USDC    :", usdcAddr);
        }
    }

    // ── Step 2-3: Deploy 7 protocol contracts + HybridPool ────────────────────

    function _deployCore(
        address admin, address operator, address guardian,
        address krwAddr, address usdcAddr
    ) internal returns (Deployed memory d) {
        console.log("\n=== PROTOCOL CONTRACT ADDRESSES ===");

        d.registry = address(new ERC1967Proxy(
            address(new PairRegistry()),
            abi.encodeCall(PairRegistry.initialize, (admin, krwAddr))
        ));
        console.log("PairRegistry   :", d.registry);

        d.oracle = address(new ERC1967Proxy(
            address(new OracleAdmin()),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        ));
        console.log("OracleAdmin    :", d.oracle);

        address compliance = address(new ERC1967Proxy(
            address(new BasicCompliance()),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        ));
        console.log("Compliance     :", compliance);

        d.feeCollector = address(new ERC1967Proxy(
            address(new FeeCollector()),
            abi.encodeCall(FeeCollector.initialize, (admin))
        ));
        console.log("FeeCollector   :", d.feeCollector);

        d.settlement = address(new ERC1967Proxy(
            address(new OrderSettlement()),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                compliance, d.registry, d.feeCollector,
                10  // takerFeeBps = 0.10%
            ))
        ));
        console.log("OrderSettlement:", d.settlement);

        d.insuranceFund = address(new ERC1967Proxy(
            address(new InsuranceFund()),
            abi.encodeCall(InsuranceFund.initialize, (admin, d.settlement, guardian))
        ));
        console.log("InsuranceFund  :", d.insuranceFund);

        d.marginRegistry = address(new ERC1967Proxy(
            address(new MarginRegistry()),
            abi.encodeCall(MarginRegistry.initialize, (admin, d.settlement))
        ));
        console.log("MarginRegistry :", d.marginRegistry);

        d.pool = address(new ERC1967Proxy(
            address(new HybridPool()),
            abi.encodeCall(HybridPool.initialize, (
                admin, operator, krwAddr, usdcAddr,
                d.oracle, compliance, d.feeCollector,
                100, 4, 50  // A=100, swapFee=0.04%, slippage=0.5%
            ))
        ));
        console.log("HybridPool     :", d.pool);
    }

    // ── Step 4-6: Roles, oracle, pair registration ───────────────────────────

    function _configure(Deployed memory d, address operator, address usdcAddr) internal {
        // Roles
        FeeCollector(d.feeCollector).grantRole(
            FeeCollector(d.feeCollector).DEPOSITOR_ROLE(), d.settlement
        );
        bytes32 opRole = PairRegistry(d.registry).OPERATOR_ROLE();
        PairRegistry(d.registry).grantRole(opRole, operator);
        OracleAdmin(d.oracle).grantRole(OracleAdmin(d.oracle).OPERATOR_ROLE(), operator);

        // Oracle init
        OracleAdmin(d.oracle).initializeRate(usdcAddr, INITIAL_RATE, 4 hours, 500);

        // Liquidation config
        OrderSettlement(d.settlement).setLiquidationFee(50);
        OrderSettlement(d.settlement).setLiquidationInsuranceFund(d.insuranceFund);

        // Pair registration
        PairRegistry(d.registry).addToken(usdcAddr, false, false);
        PairRegistry(d.registry).addPair(
            usdcAddr, PairRegistry(d.registry).krwStablecoin(),
            TICK_SIZE, LOT_SIZE, MIN_ORDER_SIZE, MAX_ORDER_SIZE
        );
        console.log("\nRegistered pair: USDC/KRW");
    }

    // ── Step 7: Mint test tokens ──────────────────────────────────────────────

    function _mintTestTokens(
        address krwAddr, address usdcAddr,
        address deployer, address operator,
        address existingUsdc
    ) internal {
        MockERC20(krwAddr).mint(deployer, MINT_KRW);
        MockERC20(krwAddr).mint(operator, MINT_KRW / 10);
        if (existingUsdc == address(0)) {
            MockERC20(usdcAddr).mint(deployer, MINT_USDC);
            MockERC20(usdcAddr).mint(operator, MINT_USDC / 10);
        }
    }

    // ── Step 8: Print .env-ready output ──────────────────────────────────────

    function _printEnv(Deployed memory d, address krwAddr, address usdcAddr) internal view {
        console.log("\n=== .env COPY-PASTE (krw-dex-server) ===");
        console.log("ORDER_SETTLEMENT_ADDRESS=", d.settlement);
        console.log("PAIR_REGISTRY_ADDRESS=",    d.registry);
        console.log("ORACLE_ADMIN_ADDRESS=",     d.oracle);
        console.log("INSURANCE_FUND_ADDRESS=",   d.insuranceFund);

        console.log("\n=== .env COPY-PASTE (krw-dex-web) ===");
        console.log("VITE_ORDER_SETTLEMENT_ADDRESS=", d.settlement);
        console.log("VITE_PAIR_REGISTRY_ADDRESS=",    d.registry);
        console.log("VITE_MARGIN_REGISTRY_ADDRESS=",  d.marginRegistry);
        console.log("VITE_KRW_TOKEN_ADDRESS=",        krwAddr);
        console.log("VITE_USDC_ADDRESS=",             usdcAddr);
        console.log("VITE_HYBRID_POOL_ADDRESS=",      d.pool);
        console.log("VITE_CHAIN_ID=998");
        console.log("VITE_API_URL=https://api.hyperkrw.xyz");
        console.log("VITE_WS_URL=wss://api.hyperkrw.xyz");

        console.log("\n=== .env COPY-PASTE (krw-dex-indexer) ===");
        console.log("ORDER_SETTLEMENT_ADDRESS=", d.settlement);
        console.log("INSURANCE_FUND_ADDRESS=",   d.insuranceFund);
        console.log("ORACLE_ADMIN_ADDRESS=",     d.oracle);
        console.log("PAIR_REGISTRY_ADDRESS=",    d.registry);

        console.log("\n=== NEXT STEPS ===");
        console.log("1. Copy addresses above into .env files");
        console.log("2. Deploy server: docker compose up -d  OR railway up");
        console.log("3. Deploy frontend: vercel deploy --prod");
        console.log("4. E2E: MetaMask -> deposit KRW -> submit order -> verify fill");
        console.log("MAINNET: Transfer DEFAULT_ADMIN_ROLE to Gnosis Safe!");
    }
}
