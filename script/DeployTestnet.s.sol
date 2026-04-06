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
 *   # Copy and fill env vars
 *   cp .env.testnet.example .env.testnet
 *   source .env.testnet
 *
 *   # Dry run (no broadcast)
 *   forge script script/DeployTestnet.s.sol \
 *     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm
 *
 *   # Deploy (broadcast + verify)
 *   forge script script/DeployTestnet.s.sol \
 *     --rpc-url https://rpc.hyperliquid-testnet.xyz/evm \
 *     --broadcast
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — deploys + funds deployer with test tokens
 *   OPERATOR_ADDRESS       — server wallet (gets OPERATOR_ROLE)
 *   GUARDIAN_ADDRESS       — emergency pause wallet (gets GUARDIAN_ROLE)
 *
 * Optional env vars (if you want real tokens instead of mocks):
 *   USDC_ADDRESS           — skip MockUSDC deployment
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
    // ── Testnet trading parameters ───────────────────────────────────────────
    // KRW/USDC pair: 1 USDC = 1350 KRW (initial oracle rate)
    // Tick size = 0.01 KRW (1e16 wei), lot = 0.001 USDC (1e3 µUSDC)
    // Min order = 1 USDC-worth (~1350 KRW), Max order = 1M USDC-worth

    uint256 constant INITIAL_RATE      = 1350e18;   // 1 USDC = 1350 KRW (18 dec)
    uint256 constant TICK_SIZE         = 1e16;       // 0.01 KRW in wei
    uint256 constant LOT_SIZE          = 1e15;       // 0.001 USDC equivalent
    uint256 constant MIN_ORDER_SIZE    = 1350e18;    // ~1 USDC worth of KRW
    uint256 constant MAX_ORDER_SIZE    = 1_350_000e18; // ~1M USDC worth of KRW
    uint256 constant MINT_AMOUNT_KRW   = 10_000_000e18; // 10M KRW to deployer
    uint256 constant MINT_AMOUNT_USDC  = 10_000e6;      // 10K USDC to deployer (6 dec)

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address operator    = vm.envAddress("OPERATOR_ADDRESS");
        address guardian    = vm.envAddress("GUARDIAN_ADDRESS");
        // In testnet, admin = deployer (remember to transfer to multisig on mainnet)
        address admin       = deployer;

        address existingUsdc = vm.envOr("USDC_ADDRESS", address(0));

        vm.startBroadcast(deployerKey);

        // ── Step 1: Deploy test tokens ──────────────────────────────────────
        MockERC20 krw = new MockERC20("HyperKRW Stablecoin", "KRWS", 18);
        console.log("=== TOKEN ADDRESSES ===");
        console.log("MockKRW  (KRWS, 18 dec):", address(krw));

        MockERC20 usdc;
        if (existingUsdc == address(0)) {
            usdc = new MockERC20("USD Coin", "USDC", 6);
            console.log("MockUSDC (USDC,  6 dec):", address(usdc));
        } else {
            usdc = MockERC20(existingUsdc);
            console.log("Using existing USDC    :", address(usdc));
        }

        // ── Step 2: Deploy protocol contracts ──────────────────────────────
        console.log("\n=== PROTOCOL CONTRACT ADDRESSES ===");

        // 2a. PairRegistry
        PairRegistry registry = PairRegistry(address(new ERC1967Proxy(
            address(new PairRegistry()),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krw)))
        )));
        console.log("PairRegistry   :", address(registry));

        // 2b. OracleAdmin
        OracleAdmin oracle = OracleAdmin(address(new ERC1967Proxy(
            address(new OracleAdmin()),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        )));
        console.log("OracleAdmin    :", address(oracle));

        // 2c. BasicCompliance
        BasicCompliance compliance = BasicCompliance(address(new ERC1967Proxy(
            address(new BasicCompliance()),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));
        console.log("Compliance     :", address(compliance));

        // 2d. FeeCollector
        FeeCollector feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(new FeeCollector()),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));
        console.log("FeeCollector   :", address(feeCollector));

        // 2e. OrderSettlement
        OrderSettlement settlement = OrderSettlement(address(new ERC1967Proxy(
            address(new OrderSettlement()),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance), address(registry), address(feeCollector),
                10  // takerFeeBps = 0.10%
            ))
        )));
        console.log("OrderSettlement:", address(settlement));

        // 2f. InsuranceFund (operator = settlement so it can call deposit())
        InsuranceFund insuranceFund = InsuranceFund(address(new ERC1967Proxy(
            address(new InsuranceFund()),
            abi.encodeCall(InsuranceFund.initialize, (admin, address(settlement), guardian))
        )));
        console.log("InsuranceFund  :", address(insuranceFund));

        // 2g. MarginRegistry (operator = settlement so it can call updatePosition())
        MarginRegistry marginRegistry = MarginRegistry(address(new ERC1967Proxy(
            address(new MarginRegistry()),
            abi.encodeCall(MarginRegistry.initialize, (admin, address(settlement)))
        )));
        console.log("MarginRegistry :", address(marginRegistry));

        // ── Step 3: HybridPool KRW/USDC ────────────────────────────────────
        HybridPool pool = HybridPool(address(new ERC1967Proxy(
            address(new HybridPool()),
            abi.encodeCall(HybridPool.initialize, (
                admin, operator, address(krw), address(usdc),
                address(oracle), address(compliance), address(feeCollector),
                100,  // A = 100 (Curve amplification)
                4,    // swapFee = 0.04%
                50    // slippageThreshold = 0.5%
            ))
        )));
        console.log("HybridPool     :", address(pool));

        // ── Step 4: Post-deploy config (roles, fees, oracle) ───────────────
        // Grant FeeCollector DEPOSITOR_ROLE to settlement
        FeeCollector(feeCollector).grantRole(
            FeeCollector(feeCollector).DEPOSITOR_ROLE(), address(settlement)
        );

        // Grant PairRegistry + OracleAdmin OPERATOR_ROLE to server operator wallet
        PairRegistry(registry).grantRole(
            PairRegistry(registry).OPERATOR_ROLE(), operator
        );
        OracleAdmin(oracle).grantRole(
            OracleAdmin(oracle).OPERATOR_ROLE(), operator
        );

        // Initialize USDC → KRW oracle rate: 1 USDC = 1350 KRW
        oracle.initializeRate(
            address(usdc),
            INITIAL_RATE,
            4 hours,   // maxStaleness — operator must update within 4h
            500        // maxDeltaBps = 5% per update
        );

        // Link InsuranceFund + set liquidation fee
        settlement.setLiquidationFee(50);                             // 0.5%
        settlement.setLiquidationInsuranceFund(address(insuranceFund));

        // ── Step 5: Whitelist MockUSDC as base token ────────────────────────
        // (KRW stablecoin is always the quote; USDC is the base being traded)
        registry.addToken(address(usdc), false, false);

        // ── Step 6: Register USDC/KRW trading pair ─────────────────────────
        registry.addPair(
            address(usdc),      // baseToken  = USDC
            address(krw),       // quoteToken = KRW (always)
            TICK_SIZE,
            LOT_SIZE,
            MIN_ORDER_SIZE,
            MAX_ORDER_SIZE
        );
        console.log("\nRegistered pair: USDC/KRW");

        // ── Step 7: Mint test tokens to deployer (E2E testing) ─────────────
        krw.mint(deployer,  MINT_AMOUNT_KRW);
        krw.mint(operator,  MINT_AMOUNT_KRW / 10);  // 1M KRW to operator (for gas testing)
        if (existingUsdc == address(0)) {
            usdc.mint(deployer, MINT_AMOUNT_USDC);
            usdc.mint(operator, MINT_AMOUNT_USDC / 10);
        }

        vm.stopBroadcast();

        // ── Step 8: Print .env-ready output ────────────────────────────────
        console.log("\n=== .env COPY-PASTE (krw-dex-server) ===");
        console.log("ORDER_SETTLEMENT_ADDRESS=", address(settlement));
        console.log("PAIR_REGISTRY_ADDRESS=",    address(registry));
        console.log("ORACLE_ADMIN_ADDRESS=",     address(oracle));

        console.log("\n=== .env COPY-PASTE (krw-dex-web) ===");
        console.log("VITE_ORDER_SETTLEMENT_ADDRESS=", address(settlement));
        console.log("VITE_PAIR_REGISTRY_ADDRESS=",    address(registry));
        console.log("VITE_MARGIN_REGISTRY_ADDRESS=",  address(marginRegistry));
        console.log("VITE_KRW_TOKEN_ADDRESS=",        address(krw));
        console.log("VITE_USDC_ADDRESS=",             address(usdc));
        console.log("VITE_HYBRID_POOL_ADDRESS=",      address(pool));
        console.log("VITE_CHAIN_ID=998");
        console.log("VITE_API_URL=https://api.hyperkrw.xyz");
        console.log("VITE_WS_URL=wss://api.hyperkrw.xyz");

        console.log("\n=== NEXT STEPS ===");
        console.log("1. Copy above addresses into krw-dex-server/.env and krw-dex-web/.env");
        console.log("2. Deploy server: docker compose up -d  (or Railway)");
        console.log("3. Deploy frontend: vercel deploy --prod");
        console.log("4. E2E test: MetaMask -> deposit KRW margin -> submit order -> verify fill");
        console.log("IMPORTANT: On mainnet, transfer DEFAULT_ADMIN_ROLE to Gnosis Safe multisig!");
    }
}
