// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/OracleAdmin.sol";

contract OracleAdminPostMarkPriceTest is Test {
    OracleAdmin oracle;

    address admin    = address(0xA1);
    address operator = address(0xA2);
    address stranger = address(0xA3);

    bytes32 constant PAIR_ID = keccak256("ETH/KRW");
    uint256 constant INITIAL_MARK = 3_000_000e18; // 3,000,000 KRW per ETH

    function setUp() public {
        OracleAdmin impl = new OracleAdmin();
        oracle = OracleAdmin(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        )));

        // Grant OPERATOR_ROLE separately
        bytes32 operatorRole = oracle.OPERATOR_ROLE();
        vm.prank(admin);
        oracle.grantRole(operatorRole, operator);
    }

    // ─── 1. First post — no delta check, verify event ───────────────────────

    function test_postMarkPrice_firstPost_succeeds() public {
        vm.expectEmit(true, false, false, true);
        emit OracleAdmin.MarkPricePosted(PAIR_ID, INITIAL_MARK, block.timestamp);

        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);

        (uint256 price, uint256 ts) = oracle.getMarkPrice(PAIR_ID);
        assertEq(price, INITIAL_MARK);
        assertEq(ts,    block.timestamp);
    }

    // ─── 2. Second post within ±20% ─────────────────────────────────────────

    function test_postMarkPrice_within20pct_succeeds() public {
        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);

        // 10% increase — within 20%
        uint256 newPrice = INITIAL_MARK * 110 / 100;

        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, newPrice);

        (uint256 price,) = oracle.getMarkPrice(PAIR_ID);
        assertEq(price, newPrice);
    }

    // ─── 3. Second post >20% away → revert ──────────────────────────────────

    function test_postMarkPrice_exceeds20pct_reverts() public {
        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);

        // 25% increase — exceeds 20%
        uint256 badPrice = INITIAL_MARK * 125 / 100;

        vm.prank(operator);
        vm.expectRevert("price delta too large");
        oracle.postMarkPrice(PAIR_ID, badPrice);
    }

    // ─── 4. Zero price → revert ─────────────────────────────────────────────

    function test_postMarkPrice_zeroPrice_reverts() public {
        vm.prank(operator);
        vm.expectRevert("zero price");
        oracle.postMarkPrice(PAIR_ID, 0);
    }

    // ─── 5. Non-operator → typed AccessControl revert ───────────────────────

    function test_postMarkPrice_onlyOperator_reverts() public {
        bytes32 operatorRole = oracle.OPERATOR_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                operatorRole
            )
        );
        vm.prank(stranger);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);
    }

    // ─── 6. getMarkPrice before any post → (0, 0) ───────────────────────────

    function test_getMarkPrice_beforePost_returnsZero() public view {
        (uint256 price, uint256 ts) = oracle.getMarkPrice(PAIR_ID);
        assertEq(price, 0);
        assertEq(ts,    0);
    }

    // ─── 7. getMarkPrice after post → correct values ────────────────────────

    function test_getMarkPrice_afterPost_returnsCorrect() public {
        uint256 postTime = block.timestamp;

        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);

        (uint256 price, uint256 ts) = oracle.getMarkPrice(PAIR_ID);
        assertEq(price, INITIAL_MARK);
        assertEq(ts,    postTime);
    }

    // ─── 8. Exactly ±20% boundary → succeeds ────────────────────────────────

    function test_postMarkPrice_exactlyAt20pct_succeeds() public {
        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, INITIAL_MARK);

        // Exactly 20% increase: delta * 10_000 / base == 2_000 → allowed
        uint256 exactBoundary = INITIAL_MARK * 120 / 100;

        vm.prank(operator);
        oracle.postMarkPrice(PAIR_ID, exactBoundary);

        (uint256 price,) = oracle.getMarkPrice(PAIR_ID);
        assertEq(price, exactBoundary);
    }
}
