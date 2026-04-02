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

/// @notice Tests for the liquidation path in OrderSettlement.settleLiquidation().
contract OrderSettlementLiquidationTest is Test {
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

    uint256 constant PRICE     = 1_000e18;    // 1 BASE = 1,000 KRW
    uint256 constant AMOUNT    = 1e18;         // 1 BASE
    uint256 constant EXPIRY    = 9_999_999_999;
    uint256 constant FEE_BPS   = 10;           // 0.1%
    uint256 constant MARK      = 1_000e18;     // mark price equal to order price

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);

        baseToken = new MockERC20("Base", "BASE", 18);
        krwStable = new MockERC20("KRW",  "KRWS", 18);

        // Deploy PairRegistry
        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krwStable)))
        )));

        // Deploy BasicCompliance
        BasicCompliance compImpl = new BasicCompliance();
        compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        // Deploy FeeCollector
        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        // Deploy OrderSettlement
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

        // Setup roles and pair
        bytes32 depositorRole = feeCollector.DEPOSITOR_ROLE();
        vm.startPrank(admin);
        registry.addToken(address(baseToken), false, false);
        registry.addPair(address(baseToken), address(krwStable), 1e14, 1e15, 1e17, 1_000_000e18);
        feeCollector.grantRole(depositorRole, address(settlement));
        vm.stopPrank();

        // Fund accounts
        baseToken.mint(taker, 10e18);
        krwStable.mint(maker, 100_000e18);

        vm.prank(taker);
        baseToken.approve(address(settlement), type(uint256).max);
        vm.prank(maker);
        krwStable.approve(address(settlement), type(uint256).max);

        sigUtils = new SigUtils(settlement.domainSeparator());
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _makeLiquidationOrder(address who, bool isBuy, uint256 nonce, bool isLiq)
        internal view returns (OrderSettlement.Order memory)
    {
        return OrderSettlement.Order({
            maker:         who,
            taker:         address(0),
            baseToken:     address(baseToken),
            quoteToken:    address(krwStable),
            price:         PRICE,
            amount:        AMOUNT,
            isBuy:         isBuy,
            nonce:         nonce,
            expiry:        EXPIRY,
            isLiquidation: isLiq
        });
    }

    /// @dev Compute the quoteAmount for a full fill
    function _quoteAmount() internal pure returns (uint256) {
        return AMOUNT * PRICE / 1e18;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  1. Fee exemption for liquidation orders
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_feeExempt() public {
        // maker=buyer (isBuy=true) pays quoteToken to get BASE; taker=seller
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        uint256 takerKrwBefore = krwStable.balanceOf(taker);
        uint256 feesBefore     = feeCollector.accumulatedFees(address(krwStable));

        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, MARK);

        // No fee deducted: taker receives the full quoteAmount, feeCollector unchanged
        uint256 quote = _quoteAmount();
        assertEq(krwStable.balanceOf(taker), takerKrwBefore + quote, "Taker receives full quote");
        assertEq(feeCollector.accumulatedFees(address(krwStable)), feesBefore, "No fee collected");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  2. Slippage within cap → succeeds
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_slippageWithinCap_succeeds() public {
        // Order price is 3% above mark (within 5% cap)
        uint256 markPrice  = 1_000e18;
        uint256 orderPrice = markPrice * 103 / 100; // +3%

        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        makerOrder.price = orderPrice;
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);
        takerOrder.price = orderPrice;

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, markPrice);

        // Just verify it doesn't revert; base tokens transferred
        assertEq(baseToken.balanceOf(maker), AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  3. Slippage exceeds cap → revert
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_slippageExceedsCap_reverts() public {
        uint256 markPrice  = 1_000e18;
        uint256 orderPrice = markPrice * 110 / 100; // +10% — exceeds 5%

        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        makerOrder.price = orderPrice;
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);
        takerOrder.price = orderPrice;

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("liquidation slippage cap exceeded");
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, markPrice);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  4. LiquidationSettled event emitted with correct args
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_emitsLiquidationSettled() public {
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        bytes32 expectedPairId = keccak256(abi.encodePacked(address(baseToken), address(krwStable)));

        vm.expectEmit(true, true, false, true);
        emit OrderSettlement.LiquidationSettled(maker, expectedPairId, AMOUNT);

        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, MARK);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  5. isLiquidation=true with markPrice=0 → revert
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_requiresMarkPrice() public {
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("markPrice required for liquidation");
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  6. Normal order (isLiquidation=false) with markPrice=0 → succeeds
    // ─────────────────────────────────────────────────────────────────────────

    function test_normalOrder_noSlippageCheck() public {
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, false);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, false);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        // markPrice=0 is fine for non-liquidation
        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, 0);

        assertEq(baseToken.balanceOf(maker), AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  7. Normal order → fee IS deducted
    // ─────────────────────────────────────────────────────────────────────────

    function test_normalOrder_feeApplied() public {
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, false);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, false);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        uint256 feesBefore = feeCollector.accumulatedFees(address(krwStable));

        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, 0);

        uint256 quote          = _quoteAmount();
        uint256 expectedFee    = quote * FEE_BPS / 10_000;

        assertGt(feeCollector.accumulatedFees(address(krwStable)) - feesBefore, 0, "Fee collected");
        assertEq(feeCollector.accumulatedFees(address(krwStable)) - feesBefore, expectedFee, "Fee amount correct");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  8. EIP-712 signature with isLiquidation=true is valid
    // ─────────────────────────────────────────────────────────────────────────

    function test_liquidation_validSignatureWithFlag() public {
        OrderSettlement.Order memory makerOrder = _makeLiquidationOrder(maker, true,  0, true);
        OrderSettlement.Order memory takerOrder = _makeLiquidationOrder(taker, false, 0, true);

        bytes memory makerSig = sigUtils.sign(makerKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        // If the signature helper encodes isLiquidation correctly, this must not revert with
        // "Invalid maker signature". A successful settlement proves the sig round-trip is correct.
        vm.prank(operator);
        settlement.settleLiquidation(makerOrder, takerOrder, makerSig, takerSig, MARK);

        assertEq(baseToken.balanceOf(maker), AMOUNT, "BASE transferred to maker");
    }
}
