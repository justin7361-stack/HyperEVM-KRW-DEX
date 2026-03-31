// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/BasicCompliance.sol";

contract BasicComplianceTest is Test {
    BasicCompliance compliance;
    address admin    = address(0xA1);
    address operator = address(0xA2);
    address user     = address(0xB1);
    address token    = address(0xC1);

    function setUp() public {
        BasicCompliance impl = new BasicCompliance();
        bytes memory init = abi.encodeCall(BasicCompliance.initialize, (admin));
        compliance = BasicCompliance(address(new ERC1967Proxy(address(impl), init)));

        bytes32 operatorRole = compliance.OPERATOR_ROLE();
        vm.prank(admin);
        compliance.grantRole(operatorRole, operator);
    }

    function test_CanTrade_Default_Allowed() public view {
        (bool allowed,) = compliance.canTrade(user, token, 100e18);
        assertTrue(allowed);
    }

    function test_CanTrade_Blocked() public {
        vm.prank(operator);
        compliance.blockAddress(user);

        (bool allowed, string memory reason) = compliance.canTrade(user, token, 100e18);
        assertFalse(allowed);
        assertEq(reason, "Blocked address");
    }

    function test_CanSwap_Blocked() public {
        vm.prank(operator);
        compliance.blockAddress(user);

        (bool allowed, string memory reason) = compliance.canSwap(user, 100e18);
        assertFalse(allowed);
        assertEq(reason, "Blocked address");
    }

    function test_GeoBlock_WhenEnabled() public {
        vm.prank(operator);
        compliance.setGeoBlock(user, true);

        // geoBlock disabled globally — still allowed
        (bool allowed,) = compliance.canTrade(user, token, 100e18);
        assertTrue(allowed);

        // enable geoBlock globally
        vm.prank(admin);
        compliance.toggleGeoBlock(true);

        (allowed,) = compliance.canTrade(user, token, 100e18);
        assertFalse(allowed);
    }

    function test_UnblockAddress_OnlyAdmin() public {
        vm.prank(operator);
        compliance.blockAddress(user);

        // operator cannot unblock
        vm.prank(operator);
        vm.expectRevert();
        compliance.unblockAddress(user);

        // admin can unblock
        vm.prank(admin);
        compliance.unblockAddress(user);

        (bool allowed,) = compliance.canTrade(user, token, 100e18);
        assertTrue(allowed);
    }

    function test_OnTradeSettled_NoRevert() public {
        compliance.onTradeSettled(user, address(0xB2), token, 100e18);
    }

    function test_BlockAddress_RevertNonOperator() public {
        vm.prank(admin);
        vm.expectRevert();
        compliance.blockAddress(user);
    }

    function test_DisableInitializers_OnImpl() public {
        BasicCompliance impl = new BasicCompliance();
        vm.expectRevert();
        impl.initialize(admin);
    }
}
