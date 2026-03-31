// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/OracleAdmin.sol";
import "./mocks/MockERC20.sol";

contract OracleAdminTest is Test {
    OracleAdmin oracle;
    address admin    = address(0xA1);
    address operator = address(0xA2);
    address usdc;

    // 1 USDC = 1350 KRW  →  price = 1350e18
    uint256 constant INITIAL_PRICE = 1350e18;

    function setUp() public {
        usdc = address(new MockERC20("USDC", "USDC", 6));

        OracleAdmin impl = new OracleAdmin();
        bytes memory init = abi.encodeCall(OracleAdmin.initialize, (admin));
        oracle = OracleAdmin(address(new ERC1967Proxy(address(impl), init)));

        bytes32 operatorRole = oracle.OPERATOR_ROLE();
        vm.prank(admin);
        oracle.grantRole(operatorRole, operator);

        vm.prank(admin);
        oracle.initializeRate(usdc, INITIAL_PRICE, 4 hours, 500); // maxDelta 5%
    }

    function test_GetPrice_Success() public view {
        assertEq(oracle.getPrice(usdc), INITIAL_PRICE);
    }

    function test_GetPrice_RevertStale() public {
        vm.warp(block.timestamp + 5 hours);
        vm.expectRevert("Stale rate");
        oracle.getPrice(usdc);
    }

    function test_ProposeRate_Success() public {
        uint256 newPrice = 1380e18; // 2.2% delta — within 5%
        vm.prank(operator);
        oracle.proposeRate(usdc, newPrice);

        (, uint256 effectiveAt) = oracle.pendingRates(usdc);
        assertEq(effectiveAt, block.timestamp + 2 hours);
    }

    function test_ProposeRate_RevertDeltaTooLarge() public {
        uint256 newPrice = 1500e18; // ~11% delta — exceeds 5%
        vm.prank(operator);
        vm.expectRevert("Delta too large");
        oracle.proposeRate(usdc, newPrice);
    }

    function test_ApplyRate_AfterTimelock() public {
        uint256 newPrice = 1380e18;
        vm.prank(operator);
        oracle.proposeRate(usdc, newPrice);

        vm.warp(block.timestamp + 2 hours + 1);
        oracle.applyRate(usdc);

        assertEq(oracle.getPrice(usdc), newPrice);
    }

    function test_ApplyRate_RevertBeforeTimelock() public {
        uint256 newPrice = 1380e18;
        vm.prank(operator);
        oracle.proposeRate(usdc, newPrice);

        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert("Timelock not elapsed");
        oracle.applyRate(usdc);
    }

    function test_SetRateImmediate_Admin() public {
        uint256 newPrice = 1380e18;
        vm.prank(admin);
        oracle.setRateImmediate(usdc, newPrice);
        assertEq(oracle.getPrice(usdc), newPrice);
    }

    function test_SetRateImmediate_RevertNonAdmin() public {
        vm.prank(operator);
        vm.expectRevert();
        oracle.setRateImmediate(usdc, 1380e18);
    }

    function test_DisableInitializers_OnImpl() public {
        OracleAdmin impl = new OracleAdmin();
        vm.expectRevert();
        impl.initialize(admin);
    }

    function test_InitializeRate_RevertAlreadyInitialized() public {
        vm.prank(admin);
        vm.expectRevert("Already initialized");
        oracle.initializeRate(usdc, INITIAL_PRICE, 4 hours, 500);
    }

    function test_ApplyRate_RevertNoPending() public {
        vm.expectRevert("No pending rate");
        oracle.applyRate(usdc);
    }

    function test_ProposeRate_RevertNonOperator() public {
        vm.prank(admin);
        vm.expectRevert();
        oracle.proposeRate(usdc, 1380e18);
    }

    function test_ProposeRate_OverwritesPending() public {
        uint256 firstPrice  = 1370e18;
        uint256 secondPrice = 1380e18;

        vm.prank(operator);
        oracle.proposeRate(usdc, firstPrice);

        uint256 firstEffectiveAt = block.timestamp + 2 hours;

        vm.warp(block.timestamp + 1 hours);
        vm.prank(operator);
        oracle.proposeRate(usdc, secondPrice);

        (uint256 price, uint256 effectiveAt) = oracle.pendingRates(usdc);
        assertEq(price, secondPrice);
        assertEq(effectiveAt, block.timestamp + 2 hours);
        assertTrue(effectiveAt > firstEffectiveAt); // timelock reset
    }
}
