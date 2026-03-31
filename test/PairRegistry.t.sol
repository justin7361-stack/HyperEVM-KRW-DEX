// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/PairRegistry.sol";
import "./mocks/MockERC20.sol";

contract PairRegistryTest is Test {
    PairRegistry registry;
    address admin    = address(0xA1);
    address operator = address(0xA2);
    address krwStable;
    address tokenA;

    function setUp() public {
        MockERC20 krw = new MockERC20("KRW Stable", "KRWS", 18);
        MockERC20 tkA = new MockERC20("Token A",    "TKA",  18);
        krwStable = address(krw);
        tokenA    = address(tkA);

        PairRegistry impl = new PairRegistry();
        bytes memory init = abi.encodeCall(PairRegistry.initialize, (admin, krwStable));
        registry = PairRegistry(address(new ERC1967Proxy(address(impl), init)));

        vm.prank(admin);
        registry.grantRole(registry.OPERATOR_ROLE(), operator);
    }

    function test_AddToken_Whitelists() public {
        vm.prank(admin);
        registry.addToken(tokenA, false, false);

        (bool wl, bool fot, bool reb) = registry.tokens(tokenA);
        assertTrue(wl);
        assertFalse(fot);
        assertFalse(reb);
    }

    function test_AddToken_RevertNonAdmin() public {
        vm.prank(operator);
        vm.expectRevert();
        registry.addToken(tokenA, false, false);
    }

    function test_AddPair_Success() public {
        vm.startPrank(admin);
        registry.addToken(tokenA, false, false);
        registry.addPair(tokenA, krwStable, 1e14, 1e15, 10e18, 1_000_000e18);
        vm.stopPrank();

        bytes32 pid = registry.getPairId(tokenA, krwStable);
        (address base,, uint256 tick,,,, bool active) = registry.pairs(pid);
        assertEq(base, tokenA);
        assertTrue(active);
        assertEq(tick, 1e14);
    }

    function test_AddPair_RevertTokenNotWhitelisted() public {
        vm.prank(admin);
        vm.expectRevert("Base token not whitelisted");
        registry.addPair(tokenA, krwStable, 1e14, 1e15, 10e18, 1_000_000e18);
    }

    function test_SetPairActive_Operator() public {
        vm.startPrank(admin);
        registry.addToken(tokenA, false, false);
        registry.addPair(tokenA, krwStable, 1e14, 1e15, 10e18, 1_000_000e18);
        vm.stopPrank();

        bytes32 pid = registry.getPairId(tokenA, krwStable);
        vm.prank(operator);
        registry.setPairActive(pid, false);

        (,,,,,,bool active) = registry.pairs(pid);
        assertFalse(active);
    }

    function test_IsTradeAllowed_FeeOnTransferBlocked() public {
        vm.startPrank(admin);
        registry.addToken(tokenA, true, false);
        registry.addPair(tokenA, krwStable, 1e14, 1e15, 10e18, 1_000_000e18);
        vm.stopPrank();

        assertFalse(registry.isTradeAllowed(tokenA, krwStable));
    }

    function test_UpdateKrwStablecoin() public {
        address newKrw = address(new MockERC20("KRW2", "KRW2", 18));
        vm.prank(admin);
        registry.updateKrwStablecoin(newKrw);
        assertEq(registry.krwStablecoin(), newKrw);
    }

    function test_DisableInitializers_OnImpl() public {
        PairRegistry impl = new PairRegistry();
        vm.expectRevert();
        impl.initialize(admin, krwStable);
    }
}
