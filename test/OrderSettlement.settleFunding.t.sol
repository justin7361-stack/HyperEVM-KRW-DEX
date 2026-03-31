// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/OrderSettlement.sol";
import "../src/PairRegistry.sol";
import "../src/FeeCollector.sol";
import "../src/BasicCompliance.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract OrderSettlementFundingTest is Test {
    OrderSettlement settlement;
    PairRegistry    registry;
    FeeCollector    feeCollector;
    BasicCompliance compliance;
    MockERC20       krw;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address reserve  = makeAddr("reserve");
    address makerA   = makeAddr("makerA");
    address makerB   = makeAddr("makerB");

    function setUp() public {
        krw = new MockERC20("KRW", "KRW");

        // Deploy contracts via ERC1967Proxy (UUPS pattern)
        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krw)))
        )));

        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        BasicCompliance compImpl = new BasicCompliance();
        compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        OrderSettlement settleImpl = new OrderSettlement();
        settlement = OrderSettlement(address(new ERC1967Proxy(
            address(settleImpl),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance),
                address(registry),
                address(feeCollector),
                30
            ))
        )));

        // Grant DEPOSITOR_ROLE to settlement on feeCollector
        bytes32 depositorRole = feeCollector.DEPOSITOR_ROLE();
        vm.prank(admin);
        feeCollector.grantRole(depositorRole, address(settlement));

        // Mint tokens
        krw.mint(reserve, 1_000_000 ether);
        krw.mint(makerA, 1_000_000 ether);
        krw.mint(makerB, 1_000_000 ether);

        // Approvals — reserve and makers approve settlement
        vm.prank(reserve);
        krw.approve(address(settlement), type(uint256).max);
        vm.prank(makerA);
        krw.approve(address(settlement), type(uint256).max);
        vm.prank(makerB);
        krw.approve(address(settlement), type(uint256).max);
    }

    function test_settleFunding_positiveAmount_makerReceives() public {
        // makerA receives 100 KRW (positive amount)
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](1);
        payments[0] = OrderSettlement.FundingPayment({
            maker: makerA,
            quoteToken: address(krw),
            amount: int256(100 ether),
            pairId: "ETH/KRW",
            timestamp: block.timestamp
        });

        uint256 reserveBefore = krw.balanceOf(reserve);
        uint256 makerABefore  = krw.balanceOf(makerA);

        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        settlement.settleFunding(payments, reserve);

        assertEq(krw.balanceOf(reserve), reserveBefore - 100 ether, "Reserve decreased");
        assertEq(krw.balanceOf(makerA),  makerABefore  + 100 ether, "MakerA received");
    }

    function test_settleFunding_negativeAmount_makerPays() public {
        // makerA pays 50 KRW (negative amount)
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](1);
        payments[0] = OrderSettlement.FundingPayment({
            maker: makerA,
            quoteToken: address(krw),
            amount: -int256(50 ether),
            pairId: "ETH/KRW",
            timestamp: block.timestamp
        });

        uint256 reserveBefore = krw.balanceOf(reserve);
        uint256 makerABefore  = krw.balanceOf(makerA);

        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        settlement.settleFunding(payments, reserve);

        assertEq(krw.balanceOf(reserve), reserveBefore + 50 ether, "Reserve increased");
        assertEq(krw.balanceOf(makerA),  makerABefore  - 50 ether, "MakerA paid");
    }

    function test_settleFunding_batch_multiplePayments() public {
        // makerA receives 100, makerB pays 75
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](2);
        payments[0] = OrderSettlement.FundingPayment({
            maker: makerA, quoteToken: address(krw),
            amount: int256(100 ether), pairId: "ETH/KRW", timestamp: block.timestamp
        });
        payments[1] = OrderSettlement.FundingPayment({
            maker: makerB, quoteToken: address(krw),
            amount: -int256(75 ether), pairId: "ETH/KRW", timestamp: block.timestamp
        });

        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        settlement.settleFunding(payments, reserve);

        // Net reserve change: -100 + 75 = -25
        // Just verify individual changes
        assertEq(krw.balanceOf(makerA), 1_000_000 ether + 100 ether);
        assertEq(krw.balanceOf(makerB), 1_000_000 ether - 75 ether);
    }

    function test_settleFunding_zeroAmount_skipped() public {
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](1);
        payments[0] = OrderSettlement.FundingPayment({
            maker: makerA, quoteToken: address(krw),
            amount: 0, pairId: "ETH/KRW", timestamp: block.timestamp
        });

        uint256 makerABefore = krw.balanceOf(makerA);

        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        settlement.settleFunding(payments, reserve);

        assertEq(krw.balanceOf(makerA), makerABefore, "Zero amount skipped");
    }

    function test_settleFunding_onlyOperator() public {
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](0);
        vm.prank(makerA);
        vm.expectRevert();
        settlement.settleFunding(payments, reserve);
    }

    function test_settleFunding_emitsFundingSettled() public {
        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](1);
        payments[0] = OrderSettlement.FundingPayment({
            maker: makerA, quoteToken: address(krw),
            amount: int256(100 ether), pairId: "ETH/KRW", timestamp: block.timestamp
        });

        vm.expectEmit(true, true, false, true);
        emit OrderSettlement.FundingSettled(makerA, address(krw), int256(100 ether), "ETH/KRW");

        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        settlement.settleFunding(payments, reserve);
    }

    function test_settleFunding_paused_reverts() public {
        bytes32 gRole = settlement.GUARDIAN_ROLE();
        vm.prank(guardian);
        settlement.pause();

        OrderSettlement.FundingPayment[] memory payments = new OrderSettlement.FundingPayment[](0);
        bytes32 opRole = settlement.OPERATOR_ROLE();
        vm.prank(operator);
        vm.expectRevert();
        settlement.settleFunding(payments, reserve);
    }
}
