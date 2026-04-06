// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/OrderSettlement.sol";
import "../src/InsuranceFund.sol";
import "../src/PairRegistry.sol";
import "../src/FeeCollector.sol";
import "../src/BasicCompliance.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20ADL is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract OrderSettlementADLTest is Test {
    OrderSettlement settlement;
    InsuranceFund   insuranceFund;
    PairRegistry    registry;
    FeeCollector    feeCollector;
    BasicCompliance compliance;
    MockERC20ADL    krw;

    address admin    = makeAddr("admin");
    address operator = makeAddr("operator");
    address guardian = makeAddr("guardian");
    address makerA   = makeAddr("makerA");
    address makerB   = makeAddr("makerB");
    address makerC   = makeAddr("makerC");

    bytes32 constant PAIR_ID = keccak256("ETH/KRW");

    function setUp() public {
        krw = new MockERC20ADL("KRW", "KRW");

        // Deploy PairRegistry
        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krw)))
        )));

        // Deploy FeeCollector
        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        // Deploy BasicCompliance
        BasicCompliance compImpl = new BasicCompliance();
        compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        // Deploy OrderSettlement
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

        // Deploy InsuranceFund
        InsuranceFund fundImpl = new InsuranceFund();
        insuranceFund = InsuranceFund(address(new ERC1967Proxy(
            address(fundImpl),
            abi.encodeCall(InsuranceFund.initialize, (admin, operator, guardian))
        )));

        // CR-3 fix: grant OPERATOR_ROLE on InsuranceFund to settlement so it can call deposit()
        // Cache role constant BEFORE vm.prank — staticcall to OPERATOR_ROLE() would consume the prank
        bytes32 insuranceFundOpRole = insuranceFund.OPERATOR_ROLE();
        vm.prank(admin);
        insuranceFund.grantRole(insuranceFundOpRole, address(settlement));

        // Mint KRW to makers
        krw.mint(makerA, 1_000_000 ether);
        krw.mint(makerB, 1_000_000 ether);
        krw.mint(makerC, 1_000_000 ether);
        // Mint to operator for InsuranceFund deposits
        krw.mint(operator, 1_000_000 ether);

        // Operators approve InsuranceFund for deposits
        vm.prank(operator);
        krw.approve(address(insuranceFund), type(uint256).max);

        // Makers approve settlement for ADL transfers
        vm.prank(makerA);
        krw.approve(address(settlement), type(uint256).max);
        vm.prank(makerB);
        krw.approve(address(settlement), type(uint256).max);
        vm.prank(makerC);
        krw.approve(address(settlement), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Helper: build a single ADLEntry
    // -------------------------------------------------------------------------
    function _entry(address maker, uint256 amount) internal view returns (OrderSettlement.ADLEntry memory) {
        return OrderSettlement.ADLEntry({
            maker:      maker,
            pairId:     PAIR_ID,
            quoteToken: address(krw),
            amount:     amount
        });
    }

    // -------------------------------------------------------------------------
    // 1. Basic success: single entry, fund exhausted, transfer succeeds, event emitted
    // -------------------------------------------------------------------------
    function test_settleADL_basic_success() public {
        // InsuranceFund balance is 0 by default — exhausted
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](1);
        entries[0] = _entry(makerA, 100 ether);

        uint256 makerABefore  = krw.balanceOf(makerA);
        uint256 fundBefore    = krw.balanceOf(address(insuranceFund));

        vm.prank(operator);
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 100 ether);

        assertEq(krw.balanceOf(makerA),                  makerABefore - 100 ether,            "makerA debited");
        assertEq(krw.balanceOf(address(settlement)),      0,             "settlement balance zero (CR-3)");
        assertEq(krw.balanceOf(address(insuranceFund)),   fundBefore + 100 ether,  "insuranceFund credited");
    }

    // -------------------------------------------------------------------------
    // 2. Multiple entries: 3 entries, all succeed, total collected
    // -------------------------------------------------------------------------
    function test_settleADL_multiple_entries() public {
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](3);
        entries[0] = _entry(makerA, 100 ether);
        entries[1] = _entry(makerB, 200 ether);
        entries[2] = _entry(makerC, 50 ether);

        uint256 fundBefore = krw.balanceOf(address(insuranceFund));

        vm.prank(operator);
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 350 ether);

        assertEq(krw.balanceOf(makerA), 1_000_000 ether - 100 ether, "makerA debited");
        assertEq(krw.balanceOf(makerB), 1_000_000 ether - 200 ether, "makerB debited");
        assertEq(krw.balanceOf(makerC), 1_000_000 ether - 50 ether,  "makerC debited");
        assertEq(krw.balanceOf(address(settlement)), 0,               "settlement zero (CR-3)");
        assertEq(krw.balanceOf(address(insuranceFund)), fundBefore + 350 ether, "fund credited");
    }

    // -------------------------------------------------------------------------
    // 3. Skips failed entry: first has no allowance, second succeeds — ADLSkipped emitted
    // -------------------------------------------------------------------------
    function test_settleADL_skips_failed_entry() public {
        // Revoke makerA's allowance so the first entry fails
        vm.prank(makerA);
        krw.approve(address(settlement), 0);

        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](2);
        entries[0] = _entry(makerA, 100 ether); // will fail — no allowance
        entries[1] = _entry(makerB, 200 ether); // will succeed

        // Expect ADLSkipped for makerA, ADLExecuted for makerB
        vm.expectEmit(true, true, false, false);
        emit OrderSettlement.ADLSkipped(makerA, PAIR_ID);

        vm.expectEmit(true, true, false, true);
        emit OrderSettlement.ADLExecuted(makerB, PAIR_ID, 200 ether);

        vm.prank(operator);
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 200 ether);

        // makerA balance unchanged, makerB debited
        assertEq(krw.balanceOf(makerA), 1_000_000 ether, "makerA unchanged");
        assertEq(krw.balanceOf(makerB), 1_000_000 ether - 200 ether, "makerB debited");
    }

    // -------------------------------------------------------------------------
    // 4. Reverts if InsuranceFund has balance > 0
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_if_fund_not_exhausted() public {
        // Deposit 500 KRW into the InsuranceFund so it is NOT exhausted
        vm.prank(operator);
        insuranceFund.deposit(PAIR_ID, address(krw), 500 ether);

        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](1);
        entries[0] = _entry(makerA, 100 ether);

        vm.prank(operator);
        vm.expectRevert(bytes("InsuranceFund not exhausted"));
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 5. Reverts on empty entries array
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_empty_entries() public {
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](0);

        vm.prank(operator);
        vm.expectRevert(bytes("ADL: no entries"));
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 6. Reverts when totalLoss is 0
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_zero_totalLoss() public {
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](1);
        entries[0] = _entry(makerA, 100 ether);

        vm.prank(operator);
        vm.expectRevert(bytes("ADL: zero loss"));
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 0);
    }

    // -------------------------------------------------------------------------
    // 7. Reverts when called by non-operator
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_nonOperator() public {
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](1);
        entries[0] = _entry(makerA, 100 ether);

        bytes32 opRole = settlement.OPERATOR_ROLE();
        address nonOp = makeAddr("nonOperator");

        vm.prank(nonOp);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                nonOp,
                opRole
            )
        );
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 8. Reverts when contract is paused
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_when_paused() public {
        // Cache the selector before pranking
        bytes4 pausedSelector = bytes4(keccak256("EnforcedPause()"));

        vm.prank(guardian);
        settlement.pause();

        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](1);
        entries[0] = _entry(makerA, 100 ether);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(pausedSelector));
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 100 ether);
    }

    // -------------------------------------------------------------------------
    // 9. Reverts when all entries fail (no funds collected)
    // -------------------------------------------------------------------------
    function test_settleADL_reverts_all_entries_fail() public {
        // Revoke all allowances
        vm.prank(makerA);
        krw.approve(address(settlement), 0);
        vm.prank(makerB);
        krw.approve(address(settlement), 0);

        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](2);
        entries[0] = _entry(makerA, 100 ether);
        entries[1] = _entry(makerB, 200 ether);

        vm.prank(operator);
        vm.expectRevert(bytes("ADL: no funds collected"));
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 300 ether);
    }

    // -------------------------------------------------------------------------
    // 10. Correct events emitted: verify ADLExecuted args (maker, pairId, amount)
    // -------------------------------------------------------------------------
    function test_settleADL_emits_correct_events() public {
        OrderSettlement.ADLEntry[] memory entries = new OrderSettlement.ADLEntry[](2);
        entries[0] = _entry(makerA, 100 ether);
        entries[1] = _entry(makerB, 250 ether);

        // Expect exact event args for each entry
        vm.expectEmit(true, true, false, true);
        emit OrderSettlement.ADLExecuted(makerA, PAIR_ID, 100 ether);

        vm.expectEmit(true, true, false, true);
        emit OrderSettlement.ADLExecuted(makerB, PAIR_ID, 250 ether);

        vm.prank(operator);
        settlement.settleADL(entries, address(insuranceFund), PAIR_ID, 350 ether);
    }
}
