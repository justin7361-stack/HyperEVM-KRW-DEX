// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/FeeCollector.sol";
import "./mocks/MockERC20.sol";

contract FeeCollectorTest is Test {
    FeeCollector collector;
    MockERC20    token;
    address admin     = address(0xA1);
    address depositor = address(0xA2);
    address recipient = address(0xA3);

    function setUp() public {
        token = new MockERC20("KRW Stable", "KRWS", 18);

        FeeCollector impl = new FeeCollector();
        bytes memory init = abi.encodeCall(FeeCollector.initialize, (admin));
        collector = FeeCollector(address(new ERC1967Proxy(address(impl), init)));

        bytes32 depositorRole = collector.DEPOSITOR_ROLE();
        vm.prank(admin);
        collector.grantRole(depositorRole, depositor);

        token.mint(depositor, 1000e18);
        vm.prank(depositor);
        token.approve(address(collector), type(uint256).max);
    }

    function test_DepositFee() public {
        vm.prank(depositor);
        collector.depositFee(address(token), 100e18);
        assertEq(collector.accumulatedFees(address(token)), 100e18);
    }

    function test_DepositFee_RevertNonDepositor() public {
        vm.prank(admin);
        vm.expectRevert();
        collector.depositFee(address(token), 100e18);
    }

    function test_WithdrawFee() public {
        vm.prank(depositor);
        collector.depositFee(address(token), 100e18);

        vm.prank(admin);
        collector.withdrawFee(address(token), recipient, 60e18);

        assertEq(collector.accumulatedFees(address(token)), 40e18);
        assertEq(token.balanceOf(recipient), 60e18);
    }

    function test_WithdrawFee_RevertInsufficientFees() public {
        vm.prank(depositor);
        collector.depositFee(address(token), 50e18);

        vm.prank(admin);
        vm.expectRevert("Insufficient fees");
        collector.withdrawFee(address(token), recipient, 100e18);
    }

    function test_WithdrawFee_RevertNonAdmin() public {
        vm.prank(depositor);
        collector.depositFee(address(token), 100e18);

        vm.prank(depositor);
        vm.expectRevert();
        collector.withdrawFee(address(token), recipient, 50e18);
    }

    function test_DisableInitializers_OnImpl() public {
        FeeCollector impl = new FeeCollector();
        vm.expectRevert();
        impl.initialize(admin);
    }
}
