// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/PairRegistry.sol";
import "../src/OracleAdmin.sol";
import "../src/FeeCollector.sol";
import "../src/OrderSettlement.sol";
import "../src/InsuranceFund.sol";

/// @notice Post-deploy configuration script. Run once after Deploy.s.sol.
contract Config is Script {
    function run() external {
        uint256 adminKey = vm.envUint("ADMIN_PRIVATE_KEY");

        address registry      = vm.envAddress("PAIR_REGISTRY_ADDRESS");
        address oracle        = vm.envAddress("ORACLE_ADMIN_ADDRESS");
        address feeCollector  = vm.envAddress("FEE_COLLECTOR_ADDRESS");
        address settlement    = vm.envAddress("ORDER_SETTLEMENT_ADDRESS");
        address insuranceFund = vm.envAddress("INSURANCE_FUND_ADDRESS");
        address operator      = vm.envAddress("OPERATOR_ADDRESS");
        address usdc          = vm.envOr("USDC_ADDRESS", address(0));

        vm.startBroadcast(adminKey);

        // Grant FeeCollector DEPOSITOR_ROLE to settlement
        FeeCollector(feeCollector).grantRole(
            FeeCollector(feeCollector).DEPOSITOR_ROLE(), settlement
        );

        // Grant PairRegistry OPERATOR_ROLE to operator
        PairRegistry(registry).grantRole(
            PairRegistry(registry).OPERATOR_ROLE(), operator
        );

        // Grant OracleAdmin OPERATOR_ROLE to operator
        OracleAdmin(oracle).grantRole(
            OracleAdmin(oracle).OPERATOR_ROLE(), operator
        );

        // Initialize USDC rate: 1 USDC = 1350 KRW
        if (usdc != address(0)) {
            OracleAdmin(oracle).initializeRate(
                usdc,
                1350e18,  // initial rate
                4 hours,  // maxStaleness
                500       // maxDeltaBps = 5%
            );
        }

        // Link InsuranceFund to OrderSettlement — liquidation fees (0.5%) routed to fund
        OrderSettlement(settlement).setLiquidationFee(50);                          // 0.5%
        OrderSettlement(settlement).setLiquidationInsuranceFund(insuranceFund);
        console.log("LiquidationFee=50bps, InsuranceFund linked to OrderSettlement");

        // Grant InsuranceFund DEPOSITOR_ROLE to settlement (if present on InsuranceFund)
        // Note: InsuranceFund uses OPERATOR_ROLE (set to settlement at deploy time)
        // so no additional role grant is needed here.

        vm.stopBroadcast();

        console.log("Config complete. IMPORTANT:");
        console.log("1. Transfer admin role to Gnosis Safe multisig");
        console.log("2. Revoke deployer admin role");
        console.log("3. Verify contracts on explorer");
    }
}
