// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/OrderSettlement.sol";
import "../src/HybridPool.sol";
import "../src/BasicCompliance.sol";
import "../src/OracleAdmin.sol";
import "../src/PairRegistry.sol";
import "../src/FeeCollector.sol";
import "./mocks/MockERC20.sol";
import "./helpers/SigUtils.sol";

contract SecurityTest is Test {
    OrderSettlement settlement;
    PairRegistry    registry;
    BasicCompliance compliance;
    FeeCollector    feeCollector;
    SigUtils        sigUtils;
    MockERC20 baseToken;
    MockERC20 krwStable;

    address admin    = address(0xA1);
    address operator = address(0xA2);
    address guardian = address(0xA3);
    uint256 makerKey = 0x1;
    uint256 takerKey = 0x2;
    address maker;
    address taker;

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);

        baseToken = new MockERC20("Base", "BASE", 18);
        krwStable = new MockERC20("KRW",  "KRWS", 18);

        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krwStable)))
        )));

        BasicCompliance compImpl = new BasicCompliance();
        compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        OrderSettlement settleImpl = new OrderSettlement();
        settlement = OrderSettlement(address(new ERC1967Proxy(
            address(settleImpl),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance), address(registry), address(feeCollector), 10
            ))
        )));

        // Cache role constants BEFORE vm.startPrank (staticcall would consume the prank)
        bytes32 depositorRole    = feeCollector.DEPOSITOR_ROLE();
        bytes32 compOperatorRole = compliance.OPERATOR_ROLE();
        vm.startPrank(admin);
        registry.addToken(address(baseToken), false, false);
        registry.addPair(address(baseToken), address(krwStable), 1e14, 1e15, 1e17, 1_000_000e18);
        feeCollector.grantRole(depositorRole, address(settlement));
        compliance.grantRole(compOperatorRole, operator);
        vm.stopPrank();

        baseToken.mint(taker, 100e18);
        krwStable.mint(maker, 100_000e18);
        vm.prank(taker); baseToken.approve(address(settlement), type(uint256).max);
        vm.prank(maker); krwStable.approve(address(settlement), type(uint256).max);

        sigUtils = new SigUtils(settlement.domainSeparator());
    }

    function _order(address who, bool isBuy, uint256 nonce)
        internal view returns (OrderSettlement.Order memory)
    {
        return OrderSettlement.Order({
            maker: who, taker: address(0),
            baseToken: address(baseToken), quoteToken: address(krwStable),
            price: 1000e18, amount: 1e18, isBuy: isBuy,
            nonce: nonce, expiry: 9999999999,
            isLiquidation: false
        });
    }

    function test_Security_ReplayAttack_Blocked() public {
        OrderSettlement.Order memory mo  = _order(maker, true,  0);
        OrderSettlement.Order memory to_ = _order(taker, false, 0);
        bytes memory ms = sigUtils.sign(makerKey, mo);
        bytes memory ts = sigUtils.sign(takerKey, to_);

        vm.prank(operator);
        settlement.settle(mo, to_, 1e18, ms, ts);

        // Refund tokens so settlement doesn't fail on balance, but nonce is spent
        baseToken.mint(taker, 10e18);
        krwStable.mint(maker, 10_000e18);

        vm.prank(operator);
        vm.expectRevert("Maker overfill"); // Replay blocked: filledAmount already at capacity
        settlement.settle(mo, to_, 1e18, ms, ts);
    }

    function test_Security_BlockedAddress_CannotTrade() public {
        vm.prank(operator);
        compliance.blockAddress(maker);

        OrderSettlement.Order memory mo  = _order(maker, true,  0);
        OrderSettlement.Order memory to_ = _order(taker, false, 0);
        bytes memory ms = sigUtils.sign(makerKey, mo);
        bytes memory ts = sigUtils.sign(takerKey, to_);

        vm.prank(operator);
        vm.expectRevert("Blocked address");
        settlement.settle(mo, to_, 1e18, ms, ts);
    }

    function test_Security_GuardianCanPause_CannotUnpause() public {
        vm.prank(guardian);
        settlement.pause();
        assertTrue(settlement.paused());

        vm.prank(guardian);
        vm.expectRevert();
        settlement.unpause();

        vm.prank(admin);
        settlement.unpause();
        assertFalse(settlement.paused());
    }

    function test_Security_OperatorCannotWithdrawFees() public {
        vm.prank(operator);
        vm.expectRevert();
        feeCollector.withdrawFee(address(krwStable), operator, 1e18);
    }

    function test_Security_CannotUpgradeWithoutAdmin() public {
        address newImpl = address(new OrderSettlement());
        vm.prank(operator);
        vm.expectRevert();
        settlement.upgradeToAndCall(newImpl, "");
    }

    function test_Security_ExpiredOrder_Blocked() public {
        OrderSettlement.Order memory mo  = _order(maker, true, 0);
        mo.expiry = block.timestamp - 1;
        OrderSettlement.Order memory to_ = _order(taker, false, 0);

        bytes memory ms = sigUtils.sign(makerKey, mo);
        bytes memory ts = sigUtils.sign(takerKey, to_);

        vm.prank(operator);
        vm.expectRevert("Maker expired");
        settlement.settle(mo, to_, 1e18, ms, ts);
    }
}
