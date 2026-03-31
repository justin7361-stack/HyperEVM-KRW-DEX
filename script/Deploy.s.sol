// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/PairRegistry.sol";
import "../src/OracleAdmin.sol";
import "../src/BasicCompliance.sol";
import "../src/FeeCollector.sol";
import "../src/OrderSettlement.sol";
import "../src/HybridPool.sol";

contract Deploy is Script {
    function run() external {
        address admin    = vm.envAddress("ADMIN_ADDRESS");
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address krw      = vm.envAddress("KRW_STABLECOIN_ADDRESS");
        address usdc     = vm.envOr("USDC_ADDRESS", address(0));
        address usdt     = vm.envOr("USDT_ADDRESS", address(0));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        // 1. PairRegistry
        PairRegistry registry = PairRegistry(address(new ERC1967Proxy(
            address(new PairRegistry()),
            abi.encodeCall(PairRegistry.initialize, (admin, krw))
        )));
        console.log("PairRegistry:", address(registry));

        // 2. OracleAdmin
        OracleAdmin oracle = OracleAdmin(address(new ERC1967Proxy(
            address(new OracleAdmin()),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        )));
        console.log("OracleAdmin:", address(oracle));

        // 3. BasicCompliance
        BasicCompliance compliance = BasicCompliance(address(new ERC1967Proxy(
            address(new BasicCompliance()),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));
        console.log("BasicCompliance:", address(compliance));

        // 4. FeeCollector
        FeeCollector feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(new FeeCollector()),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));
        console.log("FeeCollector:", address(feeCollector));

        // 5. OrderSettlement
        OrderSettlement settlement = OrderSettlement(address(new ERC1967Proxy(
            address(new OrderSettlement()),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance), address(registry), address(feeCollector),
                10 // takerFeeBps = 0.1%
            ))
        )));
        console.log("OrderSettlement:", address(settlement));

        // 6. HybridPool KRW/USDC
        if (usdc != address(0)) {
            HybridPool poolUsdc = HybridPool(address(new ERC1967Proxy(
                address(new HybridPool()),
                abi.encodeCall(HybridPool.initialize, (
                    admin, operator, krw, usdc,
                    address(oracle), address(compliance), address(feeCollector),
                    100,  // A = 100
                    4,    // swapFee = 0.04%
                    50    // slippageThreshold = 0.5%
                ))
            )));
            console.log("HybridPool KRW/USDC:", address(poolUsdc));
        }

        // 7. HybridPool KRW/USDT
        if (usdt != address(0)) {
            HybridPool poolUsdt = HybridPool(address(new ERC1967Proxy(
                address(new HybridPool()),
                abi.encodeCall(HybridPool.initialize, (
                    admin, operator, krw, usdt,
                    address(oracle), address(compliance), address(feeCollector),
                    100, 4, 50
                ))
            )));
            console.log("HybridPool KRW/USDT:", address(poolUsdt));
        }

        vm.stopBroadcast();
    }
}
