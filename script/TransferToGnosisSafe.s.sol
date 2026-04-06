// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title TransferToGnosisSafe
 * @notice R-3: Transfers DEFAULT_ADMIN_ROLE to Gnosis Safe multisig on all 7 contracts.
 *
 * Prerequisites:
 *   1. All contracts deployed (DeployTestnet.s.sol)
 *   2. Timelock deployed (SetupTimelock.s.sol) — optional but recommended
 *   3. Gnosis Safe deployed at GNOSIS_SAFE env var address
 *      (for testnet: any EOA works — no actual Safe needed)
 *
 * Usage:
 *   GNOSIS_SAFE=0x... \
 *   ORDER_SETTLEMENT=0x... \
 *   [other contract addrs] \
 *   forge script script/TransferToGnosisSafe.s.sol --rpc-url $RPC_URL --broadcast
 *
 * DANGER: After this runs, ALL admin ops require Gnosis Safe approval.
 *         Verify signers have their wallets before running on mainnet.
 */
contract TransferToGnosisSafe is Script {
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    struct Contracts {
        address settlement;
        address registry;
        address oracle;
        address feeCollector;
        address insuranceFund;
        address marginRegistry;
        address hybridPool;
    }

    function run() external {
        Contracts memory c = _loadContracts();
        address gnosisSafe = vm.envAddress("GNOSIS_SAFE");
        address deployer   = msg.sender;

        require(gnosisSafe != address(0), "GNOSIS_SAFE not set");
        require(gnosisSafe != deployer,   "Safe cannot be deployer");

        vm.startBroadcast();
        _transferAdminRoles(c, gnosisSafe, deployer);
        vm.stopBroadcast();

        _verifyTransfer(c, gnosisSafe, deployer);
        _printSummary(c, gnosisSafe);
    }

    function _loadContracts() internal view returns (Contracts memory c) {
        c.settlement    = vm.envAddress("ORDER_SETTLEMENT");
        c.registry      = vm.envAddress("PAIR_REGISTRY");
        c.oracle        = vm.envAddress("ORACLE_ADMIN");
        c.feeCollector  = vm.envAddress("FEE_COLLECTOR");
        c.insuranceFund = vm.envAddress("INSURANCE_FUND");
        c.marginRegistry= vm.envAddress("MARGIN_REGISTRY");
        c.hybridPool    = vm.envAddress("HYBRID_POOL");
    }

    function _transferAdminRoles(
        Contracts memory c,
        address gnosisSafe,
        address deployer
    ) internal {
        // For each contract: grant to Safe, then revoke from deployer
        _transferOne(c.settlement,     gnosisSafe, deployer, "OrderSettlement");
        _transferOne(c.registry,       gnosisSafe, deployer, "PairRegistry");
        _transferOne(c.oracle,         gnosisSafe, deployer, "OracleAdmin");
        _transferOne(c.feeCollector,   gnosisSafe, deployer, "FeeCollector");
        _transferOne(c.insuranceFund,  gnosisSafe, deployer, "InsuranceFund");
        _transferOne(c.marginRegistry, gnosisSafe, deployer, "MarginRegistry");
        _transferOne(c.hybridPool,     gnosisSafe, deployer, "HybridPool");
    }

    function _transferOne(
        address contractAddr,
        address gnosisSafe,
        address deployer,
        string memory name
    ) internal {
        IAccessControl ac = IAccessControl(contractAddr);
        ac.grantRole(DEFAULT_ADMIN_ROLE, gnosisSafe);
        ac.revokeRole(DEFAULT_ADMIN_ROLE, deployer);
        console.log("  [OK]", name, "->", gnosisSafe);
    }

    function _verifyTransfer(
        Contracts memory c,
        address gnosisSafe,
        address deployer
    ) internal view {
        // Assert Safe HAS role, deployer does NOT, for all 7 contracts
        _assertRole(c.settlement,     gnosisSafe, deployer, "OrderSettlement");
        _assertRole(c.registry,       gnosisSafe, deployer, "PairRegistry");
        _assertRole(c.oracle,         gnosisSafe, deployer, "OracleAdmin");
        _assertRole(c.feeCollector,   gnosisSafe, deployer, "FeeCollector");
        _assertRole(c.insuranceFund,  gnosisSafe, deployer, "InsuranceFund");
        _assertRole(c.marginRegistry, gnosisSafe, deployer, "MarginRegistry");
        _assertRole(c.hybridPool,     gnosisSafe, deployer, "HybridPool");
    }

    function _assertRole(
        address contractAddr,
        address gnosisSafe,
        address deployer,
        string memory name
    ) internal view {
        require(
            IAccessControl(contractAddr).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),
            string.concat(name, ": Safe not admin")
        );
        require(
            !IAccessControl(contractAddr).hasRole(DEFAULT_ADMIN_ROLE, deployer),
            string.concat(name, ": deployer still admin")
        );
    }

    function _printSummary(Contracts memory c, address gnosisSafe) internal view {
        console.log("\n=== R-3: Gnosis Safe Admin Transfer Complete ===");
        console.log("Gnosis Safe:", gnosisSafe);
        console.log("Contracts transferred (7/7):");
        console.log("  OrderSettlement: ", c.settlement);
        console.log("  PairRegistry:    ", c.registry);
        console.log("  OracleAdmin:     ", c.oracle);
        console.log("  FeeCollector:    ", c.feeCollector);
        console.log("  InsuranceFund:   ", c.insuranceFund);
        console.log("  MarginRegistry:  ", c.marginRegistry);
        console.log("  HybridPool:      ", c.hybridPool);
        console.log("\nNEXT STEPS:");
        console.log("  1. Use app.safe.global to manage all admin operations");
        console.log("  2. Verify 2-of-3 signers have hardware wallets ready");
        console.log("  3. For testnet EOA Safe: replace with real Safe before mainnet");
    }
}
