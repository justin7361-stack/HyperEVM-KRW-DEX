// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SetupTimelock — R-4: Deploy TimelockController and transfer DEFAULT_ADMIN_ROLE.
 *
 * After running this script, all contract upgrades require a 48-hour delay.
 * Run AFTER confirming Gnosis Safe is correctly set up.
 *
 * What it does:
 *   1. Deploy OpenZeppelin TimelockController (48h delay)
 *   2. Grant PROPOSER_ROLE to Gnosis Safe
 *   3. Grant EXECUTOR_ROLE to address(0) (anyone can execute after delay)
 *   4. Grant CANCELLER_ROLE to Gnosis Safe (can cancel malicious proposals)
 *   5. Transfer DEFAULT_ADMIN_ROLE on all 7 contracts → Timelock
 *   6. Revoke deployer's DEFAULT_ADMIN_ROLE on all contracts
 *
 * ⚠️  WARNING: Step 6 is irreversible. Verify Gnosis Safe setup first.
 *
 * Usage:
 *   source .env.mainnet
 *   forge script script/SetupTimelock.s.sol --rpc-url $RPC_URL           # dry run
 *   forge script script/SetupTimelock.s.sol --rpc-url $RPC_URL --broadcast
 *
 * Required env vars:
 *   ADMIN_PRIVATE_KEY, GNOSIS_SAFE_ADDRESS,
 *   ORDER_SETTLEMENT_ADDRESS, PAIR_REGISTRY_ADDRESS, ORACLE_ADMIN_ADDRESS,
 *   FEE_COLLECTOR_ADDRESS, INSURANCE_FUND_ADDRESS, MARGIN_REGISTRY_ADDRESS
 * Optional:
 *   HYBRID_POOL_ADDRESS, TIMELOCK_DELAY_SECONDS (default 172800 = 48h)
 */

import "forge-std/Script.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

contract SetupTimelock is Script {
    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;

    struct Contracts {
        address settlement;
        address registry;
        address oracle;
        address feeCollector;
        address insuranceFund;
        address marginRegistry;
        address hybridPool;     // address(0) if not deployed
    }

    function run() external {
        uint256 adminKey   = vm.envUint("ADMIN_PRIVATE_KEY");
        address deployer   = vm.addr(adminKey);
        address gnosisSafe = vm.envAddress("GNOSIS_SAFE_ADDRESS");
        uint256 delay      = vm.envOr("TIMELOCK_DELAY_SECONDS", uint256(48 hours));

        Contracts memory c = _loadContracts();

        console.log("=== SetupTimelock ===");
        console.log("Deployer (current admin):", deployer);
        console.log("Gnosis Safe (proposer)  :", gnosisSafe);
        console.log("Timelock delay (seconds):", delay);

        vm.startBroadcast(adminKey);

        TimelockController timelock = _deployTimelock(delay, gnosisSafe);
        _transferAdminRoles(c, address(timelock), deployer);

        vm.stopBroadcast();

        _printSummary(address(timelock));
    }

    function _loadContracts() internal view returns (Contracts memory c) {
        c.settlement     = vm.envAddress("ORDER_SETTLEMENT_ADDRESS");
        c.registry       = vm.envAddress("PAIR_REGISTRY_ADDRESS");
        c.oracle         = vm.envAddress("ORACLE_ADMIN_ADDRESS");
        c.feeCollector   = vm.envAddress("FEE_COLLECTOR_ADDRESS");
        c.insuranceFund  = vm.envAddress("INSURANCE_FUND_ADDRESS");
        c.marginRegistry = vm.envAddress("MARGIN_REGISTRY_ADDRESS");
        c.hybridPool     = vm.envOr("HYBRID_POOL_ADDRESS", address(0));
    }

    function _deployTimelock(uint256 delay, address gnosisSafe)
        internal returns (TimelockController timelock)
    {
        address[] memory proposers = new address[](1);
        address[] memory executors = new address[](1);
        proposers[0] = gnosisSafe;
        executors[0] = address(0); // anyone can execute after delay

        // admin = address(0): Timelock does NOT self-administer (immutable by design)
        timelock = new TimelockController(delay, proposers, executors, address(0));
        console.log("\nTimelockController:", address(timelock));

        // Gnosis Safe can cancel malicious proposals
        timelock.grantRole(timelock.CANCELLER_ROLE(), gnosisSafe);
        console.log("CANCELLER_ROLE granted to Gnosis Safe");
    }

    function _transferAdminRoles(Contracts memory c, address timelock, address deployer) internal {
        console.log("\nTransferring DEFAULT_ADMIN_ROLE to Timelock...");

        _transferAdmin(c.settlement,    timelock, deployer);
        _transferAdmin(c.registry,      timelock, deployer);
        _transferAdmin(c.oracle,        timelock, deployer);
        _transferAdmin(c.feeCollector,  timelock, deployer);
        _transferAdmin(c.insuranceFund, timelock, deployer);
        _transferAdmin(c.marginRegistry,timelock, deployer);
        if (c.hybridPool != address(0)) {
            _transferAdmin(c.hybridPool, timelock, deployer);
        }
    }

    function _transferAdmin(address target, address timelock, address deployer) internal {
        IAccessControl(target).grantRole(DEFAULT_ADMIN_ROLE, timelock);
        IAccessControl(target).revokeRole(DEFAULT_ADMIN_ROLE, deployer);
        console.log("  Done:", target);
    }

    function _printSummary(address timelock) internal view {
        console.log("\n=== NEXT STEPS ===");
        console.log("TIMELOCK_ADDRESS=", timelock);
        console.log("Add to .env files and update Gnosis Safe config.");
        console.log("Future upgrade flow:");
        console.log("  1. Gnosis Safe: timelock.schedule(target, 0, calldata, 0, salt, delay)");
        console.log("  2. Wait delay seconds (48h mainnet / 5min testnet)");
        console.log("  3. Anyone: timelock.execute(target, 0, calldata, 0, salt)");
        console.log("To cancel: Gnosis Safe calls timelock.cancel(operationId)");
        console.log("\nIMPORTANT: Verify deployer no longer has DEFAULT_ADMIN_ROLE!");
    }
}
