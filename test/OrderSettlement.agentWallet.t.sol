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

/// @title Agent Wallet Delegation Tests (S-3-2 — Hyperliquid pattern)
contract OrderSettlementAgentWalletTest is Test {
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

    uint256 makerKey  = 0x1;
    uint256 takerKey  = 0x2;
    uint256 agentKey  = 0x3;
    address maker;
    address taker;
    address agent;

    uint256 constant PRICE   = 1000e18;
    uint256 constant AMOUNT  = 1e18;
    uint256 constant EXPIRY  = 9999999999;
    uint256 constant FEE_BPS = 10;

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);
        agent = vm.addr(agentKey);

        baseToken = new MockERC20("Base", "BASE", 18);
        krwStable = new MockERC20("KRW",  "KRWS", 18);

        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krwStable)))
        )));

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

        OrderSettlement impl = new OrderSettlement();
        settlement = OrderSettlement(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance), address(registry), address(feeCollector), FEE_BPS
            ))
        )));

        sigUtils = new SigUtils(settlement.domainSeparator());

        // Setup roles and whitelist pair
        bytes32 depositorRole = feeCollector.DEPOSITOR_ROLE();
        vm.startPrank(admin);
        registry.addToken(address(baseToken), false, false);
        registry.addPair(address(baseToken), address(krwStable), 1e14, 1e15, 1e17, 1_000_000e18);
        feeCollector.grantRole(depositorRole, address(settlement));
        vm.stopPrank();

        // Fund accounts (maker sells BASE for KRW → taker buys BASE)
        baseToken.mint(maker, 10e18);
        krwStable.mint(taker, 100_000e18);
        vm.prank(maker); baseToken.approve(address(settlement), type(uint256).max);
        vm.prank(taker); krwStable.approve(address(settlement), type(uint256).max);
    }

    // ─────────────────────────────────────────────
    //  approveAgent / revokeAgent
    // ─────────────────────────────────────────────

    function test_approveAgent_stores_agent() public {
        vm.prank(maker);
        settlement.approveAgent(agent);
        assertEq(settlement.agentOf(maker), agent);
    }

    function test_approveAgent_emits_event() public {
        vm.expectEmit(true, true, false, false, address(settlement));
        emit OrderSettlement.AgentApproved(maker, agent);
        vm.prank(maker);
        settlement.approveAgent(agent);
    }

    function test_approveAgent_overwrites_existing() public {
        address agent2 = address(0xBEEF);
        vm.prank(maker);
        settlement.approveAgent(agent);
        vm.prank(maker);
        settlement.approveAgent(agent2);
        assertEq(settlement.agentOf(maker), agent2);
    }

    function test_approveAgent_reverts_zero_address() public {
        vm.prank(maker);
        vm.expectRevert("Zero agent");
        settlement.approveAgent(address(0));
    }

    function test_approveAgent_reverts_self() public {
        vm.prank(maker);
        vm.expectRevert("Agent cannot be self");
        settlement.approveAgent(maker);
    }

    function test_revokeAgent_clears_agent() public {
        vm.prank(maker);
        settlement.approveAgent(agent);
        vm.prank(maker);
        settlement.revokeAgent();
        assertEq(settlement.agentOf(maker), address(0));
    }

    function test_revokeAgent_emits_event() public {
        vm.prank(maker);
        settlement.approveAgent(agent);
        vm.expectEmit(true, false, false, false, address(settlement));
        emit OrderSettlement.AgentRevoked(maker);
        vm.prank(maker);
        settlement.revokeAgent();
    }

    function test_revokeAgent_reverts_when_no_agent() public {
        vm.prank(maker);
        vm.expectRevert("No agent set");
        settlement.revokeAgent();
    }

    // ─────────────────────────────────────────────
    //  Settlement with agent signature
    // ─────────────────────────────────────────────

    function test_settle_accepts_agent_signature() public {
        // Maker approves agent
        vm.prank(maker);
        settlement.approveAgent(agent);

        // Build orders where maker field = maker address
        OrderSettlement.Order memory makerOrder = OrderSettlement.Order({
            maker: maker, taker: address(0), baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: false, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });
        OrderSettlement.Order memory takerOrder = OrderSettlement.Order({
            maker: taker, taker: maker, baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: true, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });

        // Agent signs maker's order (agentKey, not makerKey)
        bytes memory makerSigByAgent = sigUtils.sign(agentKey, makerOrder);
        bytes memory takerSig        = sigUtils.sign(takerKey, takerOrder);

        // Operator settles — should succeed because agent is registered
        vm.prank(operator);
        settlement.settle(makerOrder, takerOrder, AMOUNT, makerSigByAgent, takerSig);

        assertEq(baseToken.balanceOf(taker), AMOUNT);
    }

    function test_settle_rejects_wrong_agent_signature() public {
        // Maker approves agent, but an unrelated key tries to sign
        vm.prank(maker);
        settlement.approveAgent(agent);

        uint256 wrongKey = 0x99;

        OrderSettlement.Order memory makerOrder = OrderSettlement.Order({
            maker: maker, taker: address(0), baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: false, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });
        OrderSettlement.Order memory takerOrder = OrderSettlement.Order({
            maker: taker, taker: maker, baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: true, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });

        bytes memory badSig  = sigUtils.sign(wrongKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("Invalid maker signature");
        settlement.settle(makerOrder, takerOrder, AMOUNT, badSig, takerSig);
    }

    function test_settle_rejects_agent_after_revoke() public {
        vm.prank(maker);
        settlement.approveAgent(agent);
        vm.prank(maker);
        settlement.revokeAgent();

        OrderSettlement.Order memory makerOrder = OrderSettlement.Order({
            maker: maker, taker: address(0), baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: false, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });
        OrderSettlement.Order memory takerOrder = OrderSettlement.Order({
            maker: taker, taker: maker, baseToken: address(baseToken),
            quoteToken: address(krwStable), price: PRICE, amount: AMOUNT,
            isBuy: true, nonce: 0, expiry: EXPIRY, isLiquidation: false
        });

        bytes memory agentSig = sigUtils.sign(agentKey, makerOrder);
        bytes memory takerSig = sigUtils.sign(takerKey, takerOrder);

        vm.prank(operator);
        vm.expectRevert("Invalid maker signature");
        settlement.settle(makerOrder, takerOrder, AMOUNT, agentSig, takerSig);
    }
}
