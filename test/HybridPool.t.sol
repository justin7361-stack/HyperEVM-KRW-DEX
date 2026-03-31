// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/HybridPool.sol";
import "../src/OracleAdmin.sol";
import "../src/BasicCompliance.sol";
import "../src/FeeCollector.sol";
import "./mocks/MockERC20.sol";

contract HybridPoolTest is Test {
    HybridPool      pool;
    OracleAdmin     oracle;
    BasicCompliance compliance;
    FeeCollector    feeCollector;

    MockERC20 krwStable;
    MockERC20 usdc;

    address admin    = address(0xA1);
    address operator = address(0xA2);
    address lp       = address(0xB1);
    address swapper  = address(0xB2);

    uint256 constant ORACLE_PRICE = 1350e18;   // 1 USDC = 1350 KRW
    uint256 constant INITIAL_KRW  = 1_350_000e18;
    uint256 constant INITIAL_USDC = 1_000e18;
    uint256 constant SWAP_FEE_BPS = 4;
    uint256 constant A_VALUE      = 100;

    function setUp() public {
        krwStable = new MockERC20("KRW Stable", "KRWS", 18);
        usdc      = new MockERC20("USDC",       "USDC", 18);

        OracleAdmin oracleImpl = new OracleAdmin();
        oracle = OracleAdmin(address(new ERC1967Proxy(
            address(oracleImpl),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        )));
        vm.prank(admin);
        oracle.initializeRate(address(usdc), ORACLE_PRICE, 4 hours, 500);

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

        HybridPool poolImpl = new HybridPool();
        pool = HybridPool(address(new ERC1967Proxy(
            address(poolImpl),
            abi.encodeCall(HybridPool.initialize, (
                admin, operator,
                address(krwStable), address(usdc),
                address(oracle),
                address(compliance),
                address(feeCollector),
                A_VALUE,
                SWAP_FEE_BPS,
                50
            ))
        )));

        bytes32 depositorRole = feeCollector.DEPOSITOR_ROLE();
        vm.prank(admin);
        feeCollector.grantRole(depositorRole, address(pool));

        krwStable.mint(lp, INITIAL_KRW * 2);
        usdc.mint(lp,      INITIAL_USDC * 2);
        vm.startPrank(lp);
        krwStable.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool),      type(uint256).max);
        vm.stopPrank();

        krwStable.mint(swapper, 100_000e18);
        usdc.mint(swapper,      100e18);
        vm.startPrank(swapper);
        krwStable.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool),      type(uint256).max);
        vm.stopPrank();
    }

    function test_AddLiquidity_MinLiquidityLocked() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;

        vm.prank(lp);
        uint256 lpTokens = pool.addLiquidity(amounts, 0);

        assertGt(lpTokens, 0);
        assertEq(pool.balanceOf(address(0xdead)), 1000);
    }

    function test_Swap_KRWtoUSDC_CurveMode() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        uint256 swapIn = 1350e18;
        uint256 usdcBefore = usdc.balanceOf(swapper);

        vm.prank(swapper);
        uint256 out = pool.swap(address(krwStable), swapIn, 0);

        assertGt(out, 0);
        assertEq(usdc.balanceOf(swapper), usdcBefore + out);
        assertGt(out, 99e16);
    }

    function test_Swap_RevertSameBlock_AfterLiquidity() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.prank(swapper);
        vm.expectRevert("No swap in liquidity block");
        pool.swap(address(krwStable), 1350e18, 0);
    }

    function test_Swap_OracleMode_ThinPool() public {
        uint256[2] memory amounts;
        amounts[0] = 1350e18;
        amounts[1] = 1e18;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        uint256 largeSwap = 1350e18;
        vm.prank(swapper);
        uint256 out = pool.swap(address(krwStable), largeSwap, 0);

        uint256 expected = 1e18 * (10_000 - SWAP_FEE_BPS) / 10_000;
        assertApproxEqRel(out, expected, 0.001e18);
    }

    function test_Swap_RevertBelowMinAmountOut() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        vm.prank(swapper);
        vm.expectRevert("Slippage exceeded");
        pool.swap(address(krwStable), 1350e18, 2e18);
    }

    function test_RemoveLiquidity() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        uint256 lpTokens = pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        uint256[2] memory minOuts;
        vm.prank(lp);
        pool.removeLiquidity(lpTokens, minOuts);

        // LP gets back almost everything except the MINIMUM_LIQUIDITY share
        // Loss is proportional: poolBalance * MINIMUM_LIQUIDITY / totalSupply
        assertGt(krwStable.balanceOf(lp), INITIAL_KRW * 199 / 100);
    }

    function test_RampA_GradualChange() public {
        uint256 newA = 200;
        vm.prank(admin);
        pool.rampA(newA, block.timestamp + 7 days);

        assertEq(pool.currentA(), A_VALUE * 100); // stored as A * A_PRECISION

        vm.warp(block.timestamp + 3.5 days);
        uint256 midA = pool.currentA();
        assertGt(midA, A_VALUE * 100);
        assertLt(midA, newA * 100);

        vm.warp(block.timestamp + 7 days + 1);
        assertEq(pool.currentA(), newA * 100);
    }

    function test_Pause_BlocksSwap() public {
        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        vm.prank(admin);
        pool.pause();

        vm.prank(swapper);
        vm.expectRevert();
        pool.swap(address(krwStable), 1350e18, 0);
    }

    function testFuzz_Swap_NeverBelowOracleWithHighSlippage(uint256 inAmt) public {
        inAmt = bound(inAmt, 1e18, 10_000e18);

        uint256[2] memory amounts;
        amounts[0] = INITIAL_KRW;
        amounts[1] = INITIAL_USDC;
        vm.prank(lp);
        pool.addLiquidity(amounts, 0);

        vm.roll(block.number + 1);

        vm.prank(swapper);
        uint256 out = pool.swap(address(krwStable), inAmt, 0);

        uint256 oracleOut = inAmt * 1e18 / ORACLE_PRICE;
        assertGt(out, oracleOut * 98 / 100);
    }
}
