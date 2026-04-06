// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/OrderSettlement.sol";
import "../src/PairRegistry.sol";
import "../src/OracleAdmin.sol";
import "../src/BasicCompliance.sol";
import "../src/FeeCollector.sol";
import "../src/InsuranceFund.sol";
import "../src/MarginRegistry.sol";
import "../src/HybridPool.sol";
import "./mocks/MockERC20.sol";

/**
 * @title TransferToGnosisSafeTest
 * @notice R-3: Verifies that DEFAULT_ADMIN_ROLE is correctly transferred
 *         from deployer to Gnosis Safe on all 7 core contracts.
 */
contract TransferToGnosisSafeTest is Test {
    bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;

    // Actors
    address admin     = address(0xA1);
    address operator  = address(0xA2);
    address guardian  = address(0xA3);
    address gnosisSafe = address(0x5AFE);

    // All 7 contracts
    OrderSettlement settlement;
    PairRegistry    registry;
    OracleAdmin     oracle;
    FeeCollector    feeCollector;
    InsuranceFund   insuranceFund;
    MarginRegistry  marginRegistry;
    HybridPool      hybridPool;

    // Tokens needed for deployment
    MockERC20 krwToken;
    MockERC20 usdcToken;

    function setUp() public {
        // Deploy mock tokens
        krwToken  = new MockERC20("HyperKRW Stablecoin", "KRWS", 18);
        usdcToken = new MockERC20("USD Coin", "USDC", 6);

        // PairRegistry
        PairRegistry regImpl = new PairRegistry();
        registry = PairRegistry(address(new ERC1967Proxy(
            address(regImpl),
            abi.encodeCall(PairRegistry.initialize, (admin, address(krwToken)))
        )));

        // OracleAdmin
        OracleAdmin oracleImpl = new OracleAdmin();
        oracle = OracleAdmin(address(new ERC1967Proxy(
            address(oracleImpl),
            abi.encodeCall(OracleAdmin.initialize, (admin))
        )));

        // BasicCompliance (needed by OrderSettlement + HybridPool)
        BasicCompliance compImpl = new BasicCompliance();
        BasicCompliance compliance = BasicCompliance(address(new ERC1967Proxy(
            address(compImpl),
            abi.encodeCall(BasicCompliance.initialize, (admin))
        )));

        // FeeCollector
        FeeCollector feeImpl = new FeeCollector();
        feeCollector = FeeCollector(address(new ERC1967Proxy(
            address(feeImpl),
            abi.encodeCall(FeeCollector.initialize, (admin))
        )));

        // OrderSettlement
        OrderSettlement settleImpl = new OrderSettlement();
        settlement = OrderSettlement(address(new ERC1967Proxy(
            address(settleImpl),
            abi.encodeCall(OrderSettlement.initialize, (
                admin, operator, guardian,
                address(compliance), address(registry), address(feeCollector), 10
            ))
        )));

        // InsuranceFund — (admin, operator, guardian)
        InsuranceFund fundImpl = new InsuranceFund();
        insuranceFund = InsuranceFund(address(new ERC1967Proxy(
            address(fundImpl),
            abi.encodeCall(InsuranceFund.initialize, (admin, operator, guardian))
        )));

        // MarginRegistry — (admin, operator)
        MarginRegistry marginImpl = new MarginRegistry();
        marginRegistry = MarginRegistry(address(new ERC1967Proxy(
            address(marginImpl),
            abi.encodeCall(MarginRegistry.initialize, (admin, operator))
        )));

        // HybridPool — (admin, operator, krw, quote, oracle, compliance, feeCollector, A, swapFee, slippage)
        HybridPool poolImpl = new HybridPool();
        hybridPool = HybridPool(address(new ERC1967Proxy(
            address(poolImpl),
            abi.encodeCall(HybridPool.initialize, (
                admin, operator,
                address(krwToken), address(usdcToken),
                address(oracle), address(compliance), address(feeCollector),
                100, 4, 50
            ))
        )));
    }

    /// @notice Simulates what TransferToGnosisSafe.s.sol does — without env vars.
    function _doTransfer() internal {
        vm.startPrank(admin);
        _transferOne(address(settlement));
        _transferOne(address(registry));
        _transferOne(address(oracle));
        _transferOne(address(feeCollector));
        _transferOne(address(insuranceFund));
        _transferOne(address(marginRegistry));
        _transferOne(address(hybridPool));
        vm.stopPrank();
    }

    function _transferOne(address contractAddr) internal {
        IAccessControl ac = IAccessControl(contractAddr);
        ac.grantRole(DEFAULT_ADMIN_ROLE, gnosisSafe);
        ac.revokeRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    function test_GnosisSafe_HasAdminRole_OnAllContracts() public {
        _doTransfer();

        assertTrue(IAccessControl(address(settlement)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),    "settlement: Safe not admin");
        assertTrue(IAccessControl(address(registry)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),      "registry: Safe not admin");
        assertTrue(IAccessControl(address(oracle)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),        "oracle: Safe not admin");
        assertTrue(IAccessControl(address(feeCollector)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),  "feeCollector: Safe not admin");
        assertTrue(IAccessControl(address(insuranceFund)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe), "insuranceFund: Safe not admin");
        assertTrue(IAccessControl(address(marginRegistry)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),"marginRegistry: Safe not admin");
        assertTrue(IAccessControl(address(hybridPool)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe),    "hybridPool: Safe not admin");
    }

    function test_Deployer_LosesAdminRole_OnAllContracts() public {
        _doTransfer();

        assertFalse(IAccessControl(address(settlement)).hasRole(DEFAULT_ADMIN_ROLE, admin),    "settlement: deployer still admin");
        assertFalse(IAccessControl(address(registry)).hasRole(DEFAULT_ADMIN_ROLE, admin),      "registry: deployer still admin");
        assertFalse(IAccessControl(address(oracle)).hasRole(DEFAULT_ADMIN_ROLE, admin),        "oracle: deployer still admin");
        assertFalse(IAccessControl(address(feeCollector)).hasRole(DEFAULT_ADMIN_ROLE, admin),  "feeCollector: deployer still admin");
        assertFalse(IAccessControl(address(insuranceFund)).hasRole(DEFAULT_ADMIN_ROLE, admin), "insuranceFund: deployer still admin");
        assertFalse(IAccessControl(address(marginRegistry)).hasRole(DEFAULT_ADMIN_ROLE, admin),"marginRegistry: deployer still admin");
        assertFalse(IAccessControl(address(hybridPool)).hasRole(DEFAULT_ADMIN_ROLE, admin),    "hybridPool: deployer still admin");
    }

    function test_Deployer_HasAdminRole_BeforeTransfer() public view {
        // Pre-condition: admin starts with DEFAULT_ADMIN_ROLE on all 7 contracts
        assertTrue(IAccessControl(address(settlement)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(registry)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(oracle)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(feeCollector)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(insuranceFund)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(marginRegistry)).hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertTrue(IAccessControl(address(hybridPool)).hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_Transfer_IsAtomic_GrantBeforeRevoke() public {
        // Verify grant happens before revoke (Safe gets role while deployer still has it momentarily)
        // After _transferOne for settlement only, Safe has it and deployer lost it
        vm.startPrank(admin);
        _transferOne(address(settlement));
        vm.stopPrank();

        assertTrue(IAccessControl(address(settlement)).hasRole(DEFAULT_ADMIN_ROLE, gnosisSafe));
        assertFalse(IAccessControl(address(settlement)).hasRole(DEFAULT_ADMIN_ROLE, admin));

        // Other contracts still have deployer as admin
        assertTrue(IAccessControl(address(registry)).hasRole(DEFAULT_ADMIN_ROLE, admin));
    }

    function test_NonAdmin_CannotTransfer() public {
        address rando = address(0xBEEF);
        vm.startPrank(rando);
        vm.expectRevert();
        IAccessControl(address(settlement)).grantRole(DEFAULT_ADMIN_ROLE, gnosisSafe);
        vm.stopPrank();
    }
}
