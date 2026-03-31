// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/OrderSettlement.sol";
import "../src/PairRegistry.sol";
import "../src/BasicCompliance.sol";
import "../src/FeeCollector.sol";
import "./mocks/MockERC20.sol";
import "./helpers/SigUtils.sol";

contract OrderSettlementTest is Test {
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

    uint256 constant PRICE   = 1000e18; // 1 BASE = 1000 KRW
    uint256 constant AMOUNT  = 1e18;    // 1 BASE
    uint256 constant EXPIRY  = 9999999999;
    uint256 constant FEE_BPS = 10;      // 0.1%

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);

        baseToken = new MockERC20("Base", "BASE", 18);
        krwStable = new MockERC20("KRW",  "KRWS", 18);

        // Deploy registry
        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krwStable)))
        )));

        // Deploy compliance
        BasicCompliance compImpl = new BasicCompliance();
        compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        // Deploy feeCollector
        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        // Deploy settlement
        OrderSettlement settleImpl = new OrderSettlement();
        settlement = OrderSettlement(address(new ERC1967Proxy(
            address(settleImpl),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance),
                address(registry),
                address(feeCollector),
                FEE_BPS
            ))
        )));

        // Setup roles
        vm.startPrank(admin);
        registry.addToken(address(baseToken), false, false);
        registry.addPair(address(baseToken), address(krwStable), 1e14, 1e15, 1e17, 1_000_000e18);
        feeCollector.grantRole(feeCollector.DEPOSITOR_ROLE(), address(settlement));
        vm.stopPrank();

        // Fund accounts + approvals
        baseToken.mint(taker, 10e18);
        krwStable.mint(maker, 10_000e18);

        vm.prank(taker);
        baseToken.approve(address(settlement), type(uint256).max);
        vm.prank(maker);
        krwStable.approve(address(settlement), type(uint256).max);

        sigUtils = new SigUtils(settlement.domainSeparator());
    }

    function _makeOrder(address _maker, bool isBuy, uint256 nonce)
        internal
        view
        returns (OrderSettlement.Order memory)
    {
        return OrderSettlement.Order({
            maker:      _maker,
            taker:      address(0),
            baseToken:  address(baseToken),
            quoteToken: address(krwStable),
            price:      PRICE,
            amount:     AMOUNT,
            isBuy:      isBuy,
            nonce:      nonce,
            expiry:     EXPIRY
        });
    }

    function test_Settle_BuyMaker_SellTaker() public {
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        uint256 makerKrwBefore  = krwStable.balanceOf(maker);
        uint256 takerBaseBefore = baseToken.balanceOf(taker);

        vm.prank(operator);
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSig, takerSig);

        assertEq(baseToken.balanceOf(maker),  AMOUNT);
        assertEq(baseToken.balanceOf(taker),  takerBaseBefore - AMOUNT);
        uint256 quoteAmount = AMOUNT * PRICE / 1e18;
        uint256 fee         = quoteAmount * FEE_BPS / 10_000;
        assertEq(krwStable.balanceOf(taker), quoteAmount - fee);
        assertEq(krwStable.balanceOf(maker), makerKrwBefore - quoteAmount);
        assertEq(feeCollector.accumulatedFees(address(krwStable)), fee);
    }

    function test_Settle_RevertExpiredOrder() public {
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);
        makerOrder.expiry = block.timestamp - 1;

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("Maker expired");
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSig, takerSig);
    }

    function test_Settle_RevertWrongSig() public {
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);

        bytes memory wrongSig = sigUtils.sign(takerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("Invalid maker signature");
        settlement.settle(makerOrder, takerOrder, AMOUNT, wrongSig, takerSig);
    }

    function test_Settle_PartialFill() public {
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);
        makerOrder.amount = 2e18;

        krwStable.mint(maker, 10_000e18);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSig, takerSig);

        bytes32 makerHash = settlement.hashOrder(makerOrder);
        assertEq(settlement.filledAmount(makerHash), AMOUNT);
    }

    function test_CancelOrder_InvalidatesNonce() public {
        vm.prank(maker);
        settlement.cancelOrder(0);
        assertTrue(settlement.isNonceUsed(maker, 0));
    }

    function test_Settle_RevertNonOperator() public {
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);
        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(maker);
        vm.expectRevert();
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSig, takerSig);
    }

    function test_Pause_BlocksSettle() public {
        vm.prank(guardian);
        settlement.pause();

        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);
        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert();
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSig, takerSig);
    }

    function test_SetComplianceModule() public {
        BasicCompliance newComp = new BasicCompliance();
        vm.prank(admin);
        settlement.setComplianceModule(address(newComp));
        assertEq(address(settlement.compliance()), address(newComp));
    }

    function testFuzz_Settle_RandomAmount(uint256 fillAmt) public {
        fillAmt = bound(fillAmt, 1e15, 1e18);
        OrderSettlement.Order memory makerOrder = _makeOrder(maker, true,  0);
        OrderSettlement.Order memory takerOrder = _makeOrder(taker, false, 0);

        krwStable.mint(maker, 100_000e18);
        baseToken.mint(taker, 10e18);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        settlement.settle(makerOrder, takerOrder, fillAmt, makerSig, takerSig);

        bytes32 mh = settlement.hashOrder(makerOrder);
        assertEq(settlement.filledAmount(mh), fillAmt);
    }
}
