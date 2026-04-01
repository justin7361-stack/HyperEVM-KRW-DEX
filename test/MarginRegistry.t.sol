// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/MarginRegistry.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract MarginRegistryTest is Test {
    MarginRegistry registry;
    MockERC20      token;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address trader   = makeAddr("trader");
    address alice    = makeAddr("alice");

    bytes32 constant PAIR_ID = keccak256("ETH/KRW");

    function setUp() public {
        token = new MockERC20("KRW", "KRW");

        MarginRegistry impl = new MarginRegistry();
        registry = MarginRegistry(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(MarginRegistry.initialize, (admin, operator))
        )));

        // Grant guardian role — cache role constant before vm.prank to avoid consuming the prank
        bytes32 guardianRole = registry.GUARDIAN_ROLE();
        vm.prank(admin);
        registry.grantRole(guardianRole, guardian);

        // Set quote token for the pair
        vm.prank(operator);
        registry.setQuoteToken(PAIR_ID, address(token));

        // Mint tokens to trader
        token.mint(trader, 1_000_000 ether);
        vm.prank(trader);
        token.approve(address(registry), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // 1. test_updatePosition_recordsPosition
    // -------------------------------------------------------------------------

    /// @dev Operator records a position; verify getPosition returns it
    function test_updatePosition_recordsPosition() public {
        int256  size   = 5 ether;
        uint256 margin = 1000 ether;

        vm.expectEmit(true, true, false, true);
        emit MarginRegistry.PositionUpdated(trader, PAIR_ID, size, margin, MarginRegistry.MarginMode.ISOLATED);

        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, size, margin, MarginRegistry.MarginMode.ISOLATED);

        MarginRegistry.Position memory pos = registry.getPosition(trader, PAIR_ID);
        assertEq(pos.size,   size,   "size");
        assertEq(pos.margin, margin, "margin");
        assertEq(uint256(pos.mode), uint256(MarginRegistry.MarginMode.ISOLATED), "mode");
        assertGt(pos.lastUpdated, 0, "lastUpdated");
    }

    // -------------------------------------------------------------------------
    // 2. test_updatePosition_onlyOperator_reverts
    // -------------------------------------------------------------------------

    /// @dev Non-operator call reverts with typed AccessControlUnauthorizedAccount
    function test_updatePosition_onlyOperator_reverts() public {
        bytes32 opRole = registry.OPERATOR_ROLE();
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                opRole
            )
        );
        registry.updatePosition(trader, PAIR_ID, 1 ether, 100 ether, MarginRegistry.MarginMode.CROSS);
    }

    // -------------------------------------------------------------------------
    // 3. test_updatePosition_closePosition_clearsMargin
    // -------------------------------------------------------------------------

    /// @dev size=0, margin=0 → stored correctly (closed position)
    function test_updatePosition_closePosition_clearsMargin() public {
        // First open a position
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 1000 ether, MarginRegistry.MarginMode.ISOLATED);

        // Now close it
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 0, 0, MarginRegistry.MarginMode.CROSS);

        MarginRegistry.Position memory pos = registry.getPosition(trader, PAIR_ID);
        assertEq(pos.size,   0, "size should be zero");
        assertEq(pos.margin, 0, "margin should be zero");
    }

    // -------------------------------------------------------------------------
    // 4. test_updatePosition_closePosition_nonzeroMargin_reverts
    // -------------------------------------------------------------------------

    /// @dev size=0, margin>0 → reverts
    function test_updatePosition_closePosition_nonzeroMargin_reverts() public {
        vm.prank(operator);
        vm.expectRevert(bytes("margin must be zero when closed"));
        registry.updatePosition(trader, PAIR_ID, 0, 100 ether, MarginRegistry.MarginMode.CROSS);
    }

    // -------------------------------------------------------------------------
    // 5. test_isUnderMargin_false_when_no_position
    // -------------------------------------------------------------------------

    /// @dev Unknown maker (no position) returns false
    function test_isUnderMargin_false_when_no_position() public view {
        bool result = registry.isUnderMargin(alice, PAIR_ID, 2000 ether, 250);
        assertFalse(result, "should be false with no position");
    }

    // -------------------------------------------------------------------------
    // 6. test_isUnderMargin_false_when_sufficiently_margined
    // -------------------------------------------------------------------------

    /// @dev size=5e18, markPrice=2000e18 → notional=10_000e18, maintenanceBps=250 → min=250e18
    ///      margin=1000e18 > 250e18 → false
    function test_isUnderMargin_false_when_sufficiently_margined() public {
        // size = 5 ETH, margin = 1000 KRW
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 1000 ether, MarginRegistry.MarginMode.ISOLATED);

        // markPrice = 2000 KRW/ETH → notional = 10_000 KRW, maintenance at 250bps = 250 KRW
        bool result = registry.isUnderMargin(trader, PAIR_ID, 2000 ether, 250);
        assertFalse(result, "should not be under margin");
    }

    // -------------------------------------------------------------------------
    // 7. test_isUnderMargin_true_when_under_margined
    // -------------------------------------------------------------------------

    /// @dev size=5e18, markPrice=2000e18 → notional=10_000e18, maintenanceBps=250 → min=250e18
    ///      margin=100e18 < 250e18 → true
    function test_isUnderMargin_true_when_under_margined() public {
        // size = 5 ETH, margin only 100 KRW (severely undercollateralised)
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 100 ether, MarginRegistry.MarginMode.ISOLATED);

        // markPrice = 2000 KRW/ETH → notional = 10_000 KRW, maintenance at 250bps = 250 KRW
        bool result = registry.isUnderMargin(trader, PAIR_ID, 2000 ether, 250);
        assertTrue(result, "should be under margin");
    }

    // -------------------------------------------------------------------------
    // 8. test_addMargin_increases_position_margin
    // -------------------------------------------------------------------------

    /// @dev Trader adds margin to open position
    function test_addMargin_increases_position_margin() public {
        // Open a position for the trader
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 1000 ether, MarginRegistry.MarginMode.ISOLATED);

        uint256 addAmount = 500 ether;
        uint256 balBefore = token.balanceOf(trader);

        vm.expectEmit(true, true, false, true);
        emit MarginRegistry.MarginAdded(trader, PAIR_ID, addAmount);

        vm.prank(trader);
        registry.addMargin(PAIR_ID, addAmount);

        MarginRegistry.Position memory pos = registry.getPosition(trader, PAIR_ID);
        assertEq(pos.margin, 1000 ether + addAmount, "margin should increase");
        assertEq(token.balanceOf(trader), balBefore - addAmount, "tokens pulled from trader");
        assertEq(token.balanceOf(address(registry)), addAmount, "tokens held by registry");
    }

    // -------------------------------------------------------------------------
    // 9. test_addMargin_noPosition_reverts
    // -------------------------------------------------------------------------

    /// @dev Reverts if no open position
    function test_addMargin_noPosition_reverts() public {
        vm.prank(trader);
        vm.expectRevert(bytes("no open position"));
        registry.addMargin(PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 10. test_addMargin_zeroAmount_reverts
    // -------------------------------------------------------------------------

    /// @dev Reverts if amount is zero
    function test_addMargin_zeroAmount_reverts() public {
        // Open position first
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 1000 ether, MarginRegistry.MarginMode.ISOLATED);

        vm.prank(trader);
        vm.expectRevert(bytes("zero amount"));
        registry.addMargin(PAIR_ID, 0);
    }

    // -------------------------------------------------------------------------
    // 11. test_addMargin_paused_reverts
    // -------------------------------------------------------------------------

    /// @dev Reverts when contract is paused
    function test_addMargin_paused_reverts() public {
        // Open position first
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 5 ether, 1000 ether, MarginRegistry.MarginMode.ISOLATED);

        vm.prank(guardian);
        registry.pause();

        vm.prank(trader);
        vm.expectRevert();
        registry.addMargin(PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 12. test_pause_guardianCanPause_operatorCannotUnpause
    // -------------------------------------------------------------------------

    /// @dev Guardian can pause; operator cannot unpause (only admin can)
    function test_pause_guardianCanPause_operatorCannotUnpause() public {
        bytes32 adminRole = registry.DEFAULT_ADMIN_ROLE();

        // Guardian pauses
        vm.prank(guardian);
        registry.pause();

        // updatePosition reverts while paused
        vm.prank(operator);
        vm.expectRevert();
        registry.updatePosition(trader, PAIR_ID, 1 ether, 100 ether, MarginRegistry.MarginMode.CROSS);

        // Operator cannot unpause
        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                operator,
                adminRole
            )
        );
        registry.unpause();

        // Admin can unpause
        vm.prank(admin);
        registry.unpause();

        // updatePosition works again
        vm.prank(operator);
        registry.updatePosition(trader, PAIR_ID, 2 ether, 200 ether, MarginRegistry.MarginMode.CROSS);
        assertEq(registry.getPosition(trader, PAIR_ID).size, 2 ether);
    }

    // -------------------------------------------------------------------------
    // 13. test_setQuoteToken_onlyOperator
    // -------------------------------------------------------------------------

    /// @dev Operator can set quote token; non-operator reverts
    function test_setQuoteToken_onlyOperator() public {
        bytes32 newPair = keccak256("BTC/KRW");
        bytes32 opRole  = registry.OPERATOR_ROLE();

        // Non-operator reverts
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                opRole
            )
        );
        registry.setQuoteToken(newPair, address(token));

        // Operator succeeds
        vm.expectEmit(true, false, false, true);
        emit MarginRegistry.QuoteTokenSet(newPair, address(token));

        vm.prank(operator);
        registry.setQuoteToken(newPair, address(token));

        assertEq(registry.quoteTokens(newPair), address(token), "quote token stored");
    }
}
