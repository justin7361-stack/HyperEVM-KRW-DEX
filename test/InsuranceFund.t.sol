// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/InsuranceFund.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract InsuranceFundTest is Test {
    InsuranceFund fund;
    MockERC20     token;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address alice    = makeAddr("alice");

    function setUp() public {
        token = new MockERC20("KRW", "KRW");

        InsuranceFund impl = new InsuranceFund();
        fund = InsuranceFund(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(InsuranceFund.initialize, (admin, operator, guardian))
        )));

        // Mint tokens to operator (depositor) and alice (non-operator)
        token.mint(operator, 1_000_000 ether);
        token.mint(alice,    1_000_000 ether);

        // Operator approves the fund for deposits
        vm.prank(operator);
        token.approve(address(fund), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // deposit
    // -------------------------------------------------------------------------

    /// @dev Deposit 100e18 → balance == 100e18
    function test_deposit_increasesBalance() public {
        bytes32 opRole = fund.OPERATOR_ROLE();
        vm.prank(operator);
        fund.deposit(address(token), 100 ether);

        assertEq(fund.balances(address(token)), 100 ether);
        assertEq(fund.getBalance(address(token)), 100 ether);
        (opRole); // suppress unused warning
    }

    /// @dev deposit(0) reverts with "Zero amount"
    function test_deposit_zeroAmount_reverts() public {
        vm.prank(operator);
        vm.expectRevert(bytes("Zero amount"));
        fund.deposit(address(token), 0);
    }

    /// @dev Non-operator calling deposit reverts
    function test_deposit_onlyOperator_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        fund.deposit(address(token), 100 ether);
    }

    // -------------------------------------------------------------------------
    // cover
    // -------------------------------------------------------------------------

    /// @dev balance=100, loss=60 → covered=60, shortfall=0, remaining balance=40
    function test_cover_fullyCovered() public {
        vm.prank(operator);
        fund.deposit(address(token), 100 ether);

        uint256 opBalBefore = token.balanceOf(operator);

        vm.prank(operator);
        (uint256 covered, uint256 shortfall) = fund.cover(address(token), 60 ether);

        assertEq(covered,   60 ether, "covered");
        assertEq(shortfall, 0,        "shortfall");
        assertEq(fund.getBalance(address(token)), 40 ether, "fund balance");
        assertEq(token.balanceOf(operator), opBalBefore + 60 ether, "operator received");
    }

    /// @dev balance=30, loss=100 → covered=30, shortfall=70, emits InsuranceFundExhausted
    function test_cover_partiallyCovered_emitsExhausted() public {
        vm.prank(operator);
        fund.deposit(address(token), 30 ether);

        vm.expectEmit(true, false, false, true);
        emit InsuranceFund.InsuranceFundExhausted(address(token), 70 ether);

        vm.prank(operator);
        (uint256 covered, uint256 shortfall) = fund.cover(address(token), 100 ether);

        assertEq(covered,   30 ether, "covered");
        assertEq(shortfall, 70 ether, "shortfall");
        assertEq(fund.getBalance(address(token)), 0, "fund drained");
    }

    /// @dev No deposit, loss=50 → covered=0, shortfall=50
    function test_cover_emptyFund_fullShortfall() public {
        vm.expectEmit(true, false, false, true);
        emit InsuranceFund.InsuranceFundExhausted(address(token), 50 ether);

        vm.prank(operator);
        (uint256 covered, uint256 shortfall) = fund.cover(address(token), 50 ether);

        assertEq(covered,   0,        "covered zero");
        assertEq(shortfall, 50 ether, "full shortfall");
    }

    /// @dev loss=0 → (0, 0), no events emitted
    function test_cover_zeroLoss_returnsZero() public {
        vm.prank(operator);
        fund.deposit(address(token), 100 ether);

        vm.recordLogs();
        vm.prank(operator);
        (uint256 covered, uint256 shortfall) = fund.cover(address(token), 0);

        assertEq(covered,   0, "covered");
        assertEq(shortfall, 0, "shortfall");

        // No logs (no events) emitted
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "no events");
    }

    /// @dev Non-operator calling cover reverts
    function test_cover_onlyOperator_reverts() public {
        vm.prank(alice);
        vm.expectRevert();
        fund.cover(address(token), 10 ether);
    }

    // -------------------------------------------------------------------------
    // withdraw
    // -------------------------------------------------------------------------

    /// @dev Admin withdraws: balance decreases, tokens transferred
    function test_withdraw_adminOnly() public {
        vm.prank(operator);
        fund.deposit(address(token), 100 ether);

        uint256 aliceBalBefore = token.balanceOf(alice);

        vm.prank(admin);
        fund.withdraw(address(token), alice, 40 ether);

        assertEq(fund.getBalance(address(token)), 60 ether, "fund balance");
        assertEq(token.balanceOf(alice), aliceBalBefore + 40 ether, "alice received");
    }

    /// @dev withdraw more than balance reverts
    function test_withdraw_insufficientBalance_reverts() public {
        vm.prank(operator);
        fund.deposit(address(token), 50 ether);

        vm.prank(admin);
        vm.expectRevert(bytes("Insufficient balance"));
        fund.withdraw(address(token), alice, 100 ether);
    }

    // -------------------------------------------------------------------------
    // pause / unpause
    // -------------------------------------------------------------------------

    /// @dev Guardian can pause; operator cannot unpause (only admin can)
    function test_pause_guardianCanPause_operatorCannotUnpause() public {
        // Guardian pauses
        vm.prank(guardian);
        fund.pause();

        // deposit reverts while paused
        vm.prank(operator);
        vm.expectRevert();
        fund.deposit(address(token), 1 ether);

        // Operator cannot unpause
        vm.prank(operator);
        vm.expectRevert();
        fund.unpause();

        // Admin can unpause
        vm.prank(admin);
        fund.unpause();

        // deposit works again
        vm.prank(operator);
        fund.deposit(address(token), 1 ether);
        assertEq(fund.getBalance(address(token)), 1 ether);
    }

    // -------------------------------------------------------------------------
    // getBalance
    // -------------------------------------------------------------------------

    /// @dev getBalance for unknown token returns 0
    function test_getBalance_unknownToken_returnsZero() public view {
        assertEq(fund.getBalance(address(0xdead)), 0);
    }
}
