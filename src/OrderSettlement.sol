// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IComplianceModule.sol";
import "./PairRegistry.sol";
import "./FeeCollector.sol";

/// @notice Minimal interface for querying InsuranceFund balance before ADL.
interface IInsuranceFund {
    function getBalance(bytes32 pairId, address token) external view returns (uint256);
}

/// @notice Minimal interface for depositing liquidation fees into InsuranceFund.
/// @dev    OrderSettlement must hold OPERATOR_ROLE on the InsuranceFund contract.
interface IInsuranceFundDeposit {
    function deposit(bytes32 pairId, address token, uint256 amount) external;
}

/// @title OrderSettlement
/// @notice Core settlement contract for the KRW DEX CLOB. Operators submit off-chain matched
///         maker/taker orders with EIP-712 signatures for on-chain settlement.
/// @dev Key invariants:
///      - Only OPERATOR_ROLE may settle, fund, or deleverage orders.
///      - GUARDIAN_ROLE may pause; only DEFAULT_ADMIN_ROLE may unpause (deliberate asymmetry).
///      - Orders cannot be settled twice — bitmap nonces and filledAmount tracking enforce uniqueness.
///      - Liquidation orders enforce a ±5% mark price slippage cap and route fees to InsuranceFund.
///      - Regular order fees are routed to FeeCollector.
///      - CEI (Checks-Effects-Interactions) pattern is maintained throughout.
///      - ADL collected funds are deposited back into InsuranceFund (not held in this contract).
contract OrderSettlement is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    /// @notice Role identifier for accounts allowed to submit settlement batches.
    /// @dev    Held by the off-chain matching engine server. Never expose to end users.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role identifier for accounts allowed to pause the contract.
    /// @dev    Deliberately cannot unpause — only DEFAULT_ADMIN_ROLE can unpause.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @dev EIP-712 typehash for the Order struct. Must match exactly what signers hash off-chain.
    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address taker,address baseToken,address quoteToken,"
        "uint256 price,uint256 amount,bool isBuy,uint256 nonce,uint256 expiry,bool isLiquidation)"
    );

    /// @notice A signed order submitted by a maker or taker.
    struct Order {
        address maker;
        address taker;       // address(0) = any taker
        address baseToken;
        address quoteToken;
        uint256 price;       // quoteToken per baseToken (18 decimals)
        uint256 amount;      // baseToken quantity
        bool    isBuy;
        uint256 nonce;       // bitmap nonce
        uint256 expiry;      // unix timestamp
        bool    isLiquidation; // true = liquidation order: fee-exempt, ±5% slippage cap enforced
    }

    /// @notice A single funding payment record — positive amount = maker receives, negative = maker pays
    struct FundingPayment {
        address maker;
        address quoteToken; // token transferred (KRW stablecoin)
        int256  amount;     // scaled by 1e18; positive = receives, negative = pays
        bytes32 pairId;
        uint256 timestamp;
    }

    /// @notice A single ADL entry — reduce a profitable trader's position to cover a loss.
    struct ADLEntry {
        address maker;       // trader to deleverage
        bytes32 pairId;
        address quoteToken;  // token to transfer
        uint256 amount;      // amount to pull from maker (quoteToken, 18 decimals)
    }

    /// @notice Bitmap of used nonces per user per word. nonceBitmap[user][wordIndex] = bitmap.
    /// @dev    Nonce N occupies bit (N & 0xff) of word (N >> 8). Once set, cannot be unset.
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    /// @notice Cumulative base token amount filled per order hash.
    /// @dev    filledAmount[orderHash] monotonically increases up to Order.amount.
    mapping(bytes32 => uint256) public filledAmount;

    /// @notice Compliance module used to gate trades and swaps.
    IComplianceModule public compliance;

    /// @notice Registry of whitelisted trading pairs.
    PairRegistry      public pairRegistry;

    /// @notice Fee accumulator that receives regular trading fees.
    FeeCollector      public feeCollector;

    /// @notice Taker fee rate in basis points (e.g. 10 = 0.1%). Max 100 (1%).
    uint256           public takerFeeBps;

    /// @notice Liquidation fee in basis points (e.g. 50 = 0.5%).
    ///         Set to 0 to disable. When non-zero, fee is routed to liquidationInsuranceFund.
    ///         Reference: Orderly 0.6~1.2%, dYdX v4 max 1.5%.
    uint256 public liquidationFeeBps;

    /// @notice InsuranceFund contract that receives liquidation fees.
    ///         Must grant OPERATOR_ROLE to this contract on the InsuranceFund.
    ///         address(0) = disabled (even if liquidationFeeBps > 0).
    address public liquidationInsuranceFund;

    /// @notice Portion of the liquidation fee paid to the external liquidator (basis points).
    ///         e.g. 2000 = 20% of the liquidation fee goes to the liquidator.
    ///         Max 5000 (50%). Remainder goes to InsuranceFund.
    ///         Reference: Orderly Network distributed liquidator reward pattern.
    uint256 public liquidatorRewardBps;

    /// @notice Agent wallet delegations (Hyperliquid pattern — S-3-2).
    ///         agentOf[trader] = agent address that may sign orders on behalf of trader.
    ///         One active agent per trader; overwritten by re-approval.
    mapping(address => address) public agentOf;

    /// @notice Emitted when a trader approves an agent wallet.
    event AgentApproved(address indexed trader, address indexed agent);

    /// @notice Emitted when a trader revokes their agent wallet.
    event AgentRevoked(address indexed trader);

    /// @notice Emitted when a liquidation settlement is completed.
    /// @param maker  The address of the liquidated position owner.
    /// @param pairId Trading pair identifier (keccak256 of baseToken + quoteToken).
    /// @param amount Base token amount liquidated.
    event LiquidationSettled(address indexed maker, bytes32 indexed pairId, uint256 amount);

    /// @notice Emitted when a liquidation fee is deposited into the InsuranceFund.
    /// @param pairId Trading pair identifier.
    /// @param token  Quote token used for the fee.
    /// @param fee    Fee amount deposited (18 decimals).
    event LiquidationFeeRouted(bytes32 indexed pairId, address indexed token, uint256 fee);

    /// @notice Emitted when the liquidation fee rate is updated by admin.
    /// @param newFeeBps New fee rate in basis points.
    event LiquidationFeeUpdated(uint256 newFeeBps);

    /// @notice Emitted when the liquidation insurance fund address is updated by admin.
    /// @param newInsuranceFund New InsuranceFund contract address.
    event LiquidationInsuranceFundUpdated(address newInsuranceFund);

    /// @notice Emitted when an external liquidator triggers a liquidation and earns a reward.
    /// @param liquidator Address of the external liquidator.
    /// @param pairId     Trading pair identifier.
    /// @param token      Quote token used for the reward.
    /// @param reward     Reward amount paid to the liquidator.
    event LiquidatorRewarded(address indexed liquidator, bytes32 indexed pairId, address indexed token, uint256 reward);

    /// @notice Emitted when the liquidator reward rate is updated.
    /// @param newRewardBps New reward rate in basis points.
    event LiquidatorRewardUpdated(uint256 newRewardBps);

    /// @notice Emitted when a matched order pair is filled on-chain.
    /// @param orderHash  EIP-712 hash of the maker order.
    /// @param maker      Maker's address.
    /// @param taker      Taker's address.
    /// @param baseToken  Base token address.
    /// @param fillAmount Amount of base token filled.
    /// @param fee        Quote token fee charged to the taker.
    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address baseToken,
        uint256 fillAmount,
        uint256 fee
    );

    /// @notice Emitted when a user cancels an order nonce.
    /// @param user  Address that cancelled the nonce.
    /// @param nonce The cancelled nonce value.
    event OrderCancelled(address indexed user, uint256 nonce);

    /// @notice Emitted when the compliance module is replaced.
    /// @param newModule New IComplianceModule contract address.
    event ComplianceUpdated(address indexed newModule);

    /// @notice Emitted when the taker fee rate is updated.
    /// @param newFeeBps New fee rate in basis points.
    event TakerFeeUpdated(uint256 newFeeBps);

    /// @notice Emitted when a single funding payment is settled.
    /// @param maker      Maker (position holder) receiving or paying funding.
    /// @param quoteToken Token used for the payment.
    /// @param amount     Signed amount (positive = received, negative = paid).
    /// @param pairId     Trading pair identifier.
    event FundingSettled(address indexed maker, address indexed quoteToken, int256 amount, bytes32 pairId);

    /// @notice Emitted when an ADL entry is successfully executed.
    /// @param maker  Profitable trader whose position was reduced.
    /// @param pairId Trading pair identifier.
    /// @param amount Quote token amount pulled from the maker.
    event ADLExecuted(address indexed maker, bytes32 indexed pairId, uint256 amount);

    /// @notice Emitted when an ADL entry is skipped (e.g. transfer failed).
    /// @param maker  Trader whose ADL was skipped.
    /// @param pairId Trading pair identifier.
    event ADLSkipped(address indexed maker, bytes32 indexed pairId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the contract. Called once by the proxy deployer.
    /// @dev    Grants DEFAULT_ADMIN_ROLE to admin, OPERATOR_ROLE to operator,
    ///         and GUARDIAN_ROLE to guardian. EIP-712 domain is "KRW DEX" v1.
    /// @param admin         Address receiving DEFAULT_ADMIN_ROLE (governance multisig).
    /// @param operator      Address receiving OPERATOR_ROLE (off-chain matching engine).
    /// @param guardian      Address receiving GUARDIAN_ROLE (hot-wallet pause key).
    /// @param _compliance   IComplianceModule for trade gating.
    /// @param _pairRegistry PairRegistry for pair validation.
    /// @param _feeCollector FeeCollector for regular fee routing.
    /// @param _takerFeeBps  Initial taker fee in basis points (max 100).
    function initialize(
        address admin,
        address operator,
        address guardian,
        address _compliance,
        address _pairRegistry,
        address _feeCollector,
        uint256 _takerFeeBps
    ) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __EIP712_init("KRW DEX", "1");

        require(admin != address(0),         "Zero address");
        require(operator != address(0),      "Zero address");
        require(guardian != address(0),      "Zero address");
        require(_compliance != address(0),   "Zero address");
        require(_pairRegistry != address(0), "Zero address");
        require(_feeCollector != address(0), "Zero address");
        require(_takerFeeBps <= 100,         "Fee too high");

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE,      operator);
        _grantRole(GUARDIAN_ROLE,       guardian);

        compliance   = IComplianceModule(_compliance);
        pairRegistry = PairRegistry(_pairRegistry);
        feeCollector = FeeCollector(_feeCollector);
        takerFeeBps  = _takerFeeBps;
    }

    // ─────────────────────────────────────────────
    //  Settlement
    // ─────────────────────────────────────────────

    /// @notice Settle a single matched order pair.
    /// @dev    Both orders must carry valid EIP-712 signatures. Reverts if either order is
    ///         expired, the pair is inactive, compliance checks fail, or overfill is attempted.
    ///         For liquidation orders, use settleLiquidation() instead.
    /// @param makerOrder Maker's signed order struct.
    /// @param takerOrder Taker's signed order struct.
    /// @param fillAmount Amount of base token to fill (≤ min(maker.amount, taker.amount)).
    /// @param makerSig   EIP-712 signature from the maker.
    /// @param takerSig   EIP-712 signature from the taker (empty bytes = operator-signed taker).
    function settle(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256        fillAmount,
        bytes calldata makerSig,
        bytes calldata takerSig
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _settle(makerOrder, takerOrder, fillAmount, makerSig, takerSig);
    }

    /// @notice Settle multiple maker orders against one taker order (batch).
    /// @dev For liquidation orders use settleLiquidation() which enforces fee exemption
    ///      and ±5% mark price slippage cap.
    ///      Individual failures are silently skipped (best-effort via try/catch).
    /// @param makerOrders  Array of maker signed orders.
    /// @param takerOrder   Single taker order matched against all makers.
    /// @param fillAmounts  Per-maker fill amounts (must match makerOrders length).
    /// @param makerSigs    Per-maker EIP-712 signatures.
    /// @param takerSig     Taker's EIP-712 signature (shared across all fills).
    function settleBatch(
        Order[]   calldata makerOrders,
        Order     calldata takerOrder,
        uint256[] calldata fillAmounts,
        bytes[]   calldata makerSigs,
        bytes     calldata takerSig
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        require(makerOrders.length == fillAmounts.length, "Length mismatch");
        require(makerOrders.length == makerSigs.length,   "Length mismatch");

        for (uint256 i = 0; i < makerOrders.length; i++) {
            _trySettle(makerOrders[i], takerOrder, fillAmounts[i], makerSigs[i], takerSig);
        }
    }

    /// @notice Settle a single liquidation order pair with fee exemption and ±5% slippage cap.
    /// @dev markPrice must be > 0 when makerOrder.isLiquidation is true.
    ///      For non-liquidation single-pair settlement, use the array-based settleBatch.
    ///      Fill amount is automatically set to min(maker.amount, taker.amount).
    /// @param makerOrder  Maker's signed order (isLiquidation=true enables fee exemption + slippage cap).
    /// @param takerOrder  Taker's signed order.
    /// @param makerSig    EIP-712 signature from maker.
    /// @param takerSig    EIP-712 signature from taker.
    /// @param markPrice   Current mark price (18 decimals). Must be >0 when isLiquidation=true.
    function settleLiquidation(
        Order calldata makerOrder,
        Order calldata takerOrder,
        bytes calldata makerSig,
        bytes calldata takerSig,
        uint256 markPrice
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        _doSettleLiquidation(makerOrder, takerOrder, makerSig, takerSig, markPrice, address(0));
    }

    /// @notice Settle a liquidation triggered by an external liquidator.
    ///         If liquidatorRewardBps > 0, a portion of the liquidation fee is paid to `liquidator`.
    /// @param liquidator  Address of the external liquidator that triggered this liquidation.
    ///                    Receives liquidatorRewardBps % of the liquidation fee.
    function settleLiquidationWithReward(
        Order calldata makerOrder,
        Order calldata takerOrder,
        bytes calldata makerSig,
        bytes calldata takerSig,
        uint256 markPrice,
        address liquidator
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        require(liquidator != address(0), "Zero liquidator");
        _doSettleLiquidation(makerOrder, takerOrder, makerSig, takerSig, markPrice, liquidator);
    }

    /// @dev Shared liquidation settlement logic.
    function _doSettleLiquidation(
        Order calldata makerOrder,
        Order calldata takerOrder,
        bytes calldata makerSig,
        bytes calldata takerSig,
        uint256 markPrice,
        address liquidator
    ) internal {
        // Liquidation slippage cap: execution price must be within ±5% of markPrice
        if (makerOrder.isLiquidation) {
            require(markPrice > 0, "markPrice required for liquidation");
            uint256 priceDelta = makerOrder.price > markPrice
                ? makerOrder.price - markPrice
                : markPrice - makerOrder.price;
            require(priceDelta * 10_000 / markPrice <= 500, "liquidation slippage cap exceeded");
        }

        // Determine fill amount = full order amount (single-pair batch settles the full amount)
        uint256 fillAmt = makerOrder.amount < takerOrder.amount
            ? makerOrder.amount
            : takerOrder.amount;

        _settleSinglePair(makerOrder, takerOrder, fillAmt, makerSig, takerSig);

        if (makerOrder.isLiquidation) {
            bytes32 pairId = keccak256(abi.encodePacked(makerOrder.baseToken, makerOrder.quoteToken));
            emit LiquidationSettled(makerOrder.maker, pairId, fillAmt);

            // Distributed liquidator reward: split liquidation fee between liquidator and InsuranceFund
            if (liquidator != address(0) && liquidatorRewardBps > 0 && liquidationFeeBps > 0) {
                uint256 totalFee = fillAmt * liquidationFeeBps / 10_000;
                uint256 reward   = totalFee * liquidatorRewardBps / 10_000;
                if (reward > 0) {
                    SafeERC20.safeTransfer(
                        IERC20(makerOrder.quoteToken),
                        liquidator,
                        reward
                    );
                    emit LiquidatorRewarded(liquidator, pairId, makerOrder.quoteToken, reward);
                }
            }
        }
    }

    // ─────────────────────────────────────────────
    //  Agent Wallet Delegation (S-3-2 — Hyperliquid pattern)
    // ─────────────────────────────────────────────

    /// @notice Approve an agent wallet to sign orders on your behalf.
    /// @dev    Agent must not be the caller. Overwrites any existing agent.
    ///         Call revokeAgent() to remove delegation.
    /// @param agent Address of the wallet to delegate signing to.
    function approveAgent(address agent) external {
        require(agent != address(0), "Zero agent");
        require(agent != msg.sender,  "Agent cannot be self");
        agentOf[msg.sender] = agent;
        emit AgentApproved(msg.sender, agent);
    }

    /// @notice Revoke the current agent wallet delegation.
    /// @dev    Reverts if no agent is set.
    function revokeAgent() external {
        require(agentOf[msg.sender] != address(0), "No agent set");
        delete agentOf[msg.sender];
        emit AgentRevoked(msg.sender);
    }

    /// @notice Cancel a single order nonce, preventing it from being filled.
    /// @dev    Marks the nonce as used in the bitmap. Reverts if nonce was already used.
    /// @param nonce The nonce value to cancel.
    function cancelOrder(uint256 nonce) external {
        _useNonce(msg.sender, nonce);
        emit OrderCancelled(msg.sender, nonce);
    }

    /// @notice Cancel multiple nonces in one transaction.
    /// @dev    Reverts if any nonce was already used (all-or-nothing for the batch).
    /// @param nonces Array of nonce values to cancel.
    function cancelOrders(uint256[] calldata nonces) external {
        for (uint256 i = 0; i < nonces.length; i++) {
            _useNonce(msg.sender, nonces[i]);
            emit OrderCancelled(msg.sender, nonces[i]);
        }
    }

    /// @notice Settle a batch of funding payments. Operator submits payments computed
    ///         off-chain by the FundingRateEngine. Positive amount = maker receives
    ///         (funded by protocol reserve); negative amount = maker pays into reserve.
    /// @dev    Payments are processed best-effort: individual failures are skipped.
    ///         The operator must hold sufficient quoteToken approval for net outflows.
    ///         Payments older than 9 hours are silently skipped (1 funding interval + 1h grace).
    /// @param payments  Array of funding payment records.
    /// @param reserve   Address holding protocol funds for outgoing payments.
    function settleFunding(
        FundingPayment[] calldata payments,
        address reserve
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        require(reserve != address(0), "Zero reserve");
        for (uint256 i = 0; i < payments.length; i++) {
            _trySettleFunding(payments[i], reserve);
        }
    }

    /// @notice Execute Auto-Deleveraging — transfer funds from profitable traders to cover losses
    ///         when the InsuranceFund is exhausted.
    /// @dev Operator must verify InsuranceFund is exhausted before calling.
    ///      Each maker must have approved this contract to spend quoteToken.
    ///      Best-effort: skips failed entries (try/catch). Collected funds are deposited
    ///      back into the InsuranceFund (not held in this contract — CR-3 fix).
    ///      Requires: address(this) holds OPERATOR_ROLE on the InsuranceFund contract.
    /// @param entries       Array of ADL entries (profitable makers to deleverage).
    /// @param insuranceFund Address of the InsuranceFund contract to check balance.
    /// @param pairId        Trading pair identifier.
    /// @param totalLoss     Total loss amount that triggered ADL (must be > 0).
    function settleADL(
        ADLEntry[] calldata entries,
        address insuranceFund,
        bytes32 pairId,
        uint256 totalLoss
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        // 1. Require entries.length > 0 and totalLoss > 0 (needed before reading entries[0])
        require(entries.length > 0, "ADL: no entries");
        require(totalLoss > 0,      "ADL: zero loss");
        require(insuranceFund != address(0), "ADL: zero insuranceFund");

        // 2. Verify InsuranceFund balance is zero for this pairId + quoteToken
        address quoteToken = entries[0].quoteToken;
        try IInsuranceFund(insuranceFund).getBalance(pairId, quoteToken) returns (uint256 bal) {
            require(bal == 0, "InsuranceFund not exhausted");
        } catch {
            revert("InsuranceFund not exhausted");
        }

        // 3. Process each entry best-effort; accumulate collected amount
        uint256 collected = 0;
        for (uint256 i = 0; i < entries.length; i++) {
            ADLEntry calldata entry = entries[i];
            // NOTE: Intentionally use raw transferFrom (not SafeERC20.safeTransferFrom) here.
            // safeTransferFrom reverts on failure, which would prevent the `if (ok)` bool-check
            // branch from running and break the best-effort skip semantics. The catch{} block
            // handles revert-style tokens; the if(!ok) branch handles bool-returning tokens.
            try IERC20(entry.quoteToken).transferFrom(entry.maker, address(this), entry.amount) returns (bool ok) {
                if (ok) {
                    collected += entry.amount;
                    emit ADLExecuted(entry.maker, entry.pairId, entry.amount);
                } else {
                    emit ADLSkipped(entry.maker, entry.pairId);
                }
            } catch {
                emit ADLSkipped(entry.maker, entry.pairId);
            }
        }

        // 4. Require at least one entry succeeded
        require(collected > 0, "ADL: no funds collected");

        // 5. CR-3 fix: deposit collected funds into InsuranceFund so they are tracked
        //    and available for future cover() calls — was previously locked in this contract.
        //    Requires: address(this) holds OPERATOR_ROLE on the InsuranceFund contract.
        IERC20(quoteToken).forceApprove(insuranceFund, collected);
        IInsuranceFundDeposit(insuranceFund).deposit(pairId, quoteToken, collected);
    }

    // ─────────────────────────────────────────────
    //  View
    // ─────────────────────────────────────────────

    /// @notice Compute the EIP-712 hash of an order.
    /// @dev    Use this to reconstruct the digest that traders sign off-chain.
    /// @param order The order struct to hash.
    /// @return The EIP-712 typed data hash.
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.maker, order.taker, order.baseToken, order.quoteToken,
            order.price, order.amount, order.isBuy, order.nonce, order.expiry,
            order.isLiquidation
        )));
    }

    /// @notice Check whether a nonce has been used (cancelled or fully filled).
    /// @param user  The account whose nonce bitmap to query.
    /// @param nonce The nonce value to check.
    /// @return True if the nonce is already used.
    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        uint256 wordIndex = nonce >> 8;
        uint256 bitIndex  = nonce & 0xff;
        return nonceBitmap[user][wordIndex] & (1 << bitIndex) != 0;
    }

    /// @notice Return the EIP-712 domain separator for this contract.
    /// @return The domain separator hash.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    /// @notice Replace the compliance module. Admin only.
    /// @param newModule New IComplianceModule contract address (must be non-zero).
    function setComplianceModule(address newModule) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newModule != address(0), "Zero address");
        compliance = IComplianceModule(newModule);
        emit ComplianceUpdated(newModule);
    }

    /// @notice Update the taker fee rate. Admin only.
    /// @param newFeeBps New fee rate in basis points (max 100 = 1%).
    function setTakerFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= 100, "Fee too high");
        takerFeeBps = newFeeBps;
        emit TakerFeeUpdated(newFeeBps);
    }

    /// @notice Set the liquidation fee rate.
    /// @param newFeeBps Basis points (e.g. 50 = 0.5%). Max 200 (2%).
    function setLiquidationFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= 200, "Liquidation fee too high");
        liquidationFeeBps = newFeeBps;
        emit LiquidationFeeUpdated(newFeeBps);
    }

    /// @notice Set the InsuranceFund that receives liquidation fees.
    /// @dev    OrderSettlement must be granted OPERATOR_ROLE on the InsuranceFund contract.
    function setLiquidationInsuranceFund(address newInsuranceFund) external onlyRole(DEFAULT_ADMIN_ROLE) {
        liquidationInsuranceFund = newInsuranceFund;
        emit LiquidationInsuranceFundUpdated(newInsuranceFund);
    }

    /// @notice Set the liquidator reward rate (portion of liquidation fee to external liquidator).
    /// @param newRewardBps Basis points. Max 5000 (50%). Set 0 to disable distributed liquidation.
    function setLiquidatorRewardBps(uint256 newRewardBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newRewardBps <= 5000, "Reward too high");
        liquidatorRewardBps = newRewardBps;
        emit LiquidatorRewardUpdated(newRewardBps);
    }

    /// @notice GUARDIAN can pause; only ADMIN can unpause (deliberate asymmetry).
    function pause()   external onlyRole(GUARDIAN_ROLE)      { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ─────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────

    /// @dev Settlement used by settleLiquidation(). Handles liquidation fee exemption.
    function _settleSinglePair(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256        fillAmount,
        bytes calldata makerSig,
        bytes memory   takerSig
    ) internal {
        // ── Checks ──
        require(fillAmount > 0,                                 "Zero fill");
        require(block.timestamp < makerOrder.expiry,            "Maker expired");
        require(block.timestamp < takerOrder.expiry,            "Taker expired");
        require(makerOrder.isBuy != takerOrder.isBuy,           "Same direction");
        require(makerOrder.baseToken  == takerOrder.baseToken,  "Base mismatch");
        require(makerOrder.quoteToken == takerOrder.quoteToken, "Quote mismatch");

        {
            uint256 buyPrice  = makerOrder.isBuy ? makerOrder.price : takerOrder.price;
            uint256 sellPrice = makerOrder.isBuy ? takerOrder.price : makerOrder.price;
            require(buyPrice >= sellPrice, "Price mismatch");
        }

        require(
            pairRegistry.isTradeAllowed(makerOrder.baseToken, makerOrder.quoteToken),
            "Pair not active"
        );

        bytes32 makerHash = hashOrder(makerOrder);
        bytes32 takerHash = hashOrder(takerOrder);

        _verifySignature(makerOrder.maker, makerHash, makerSig);
        if (takerSig.length > 0) {
            _verifySignature(takerOrder.maker, takerHash, takerSig);
        }

        require(
            makerOrder.taker == address(0) || makerOrder.taker == takerOrder.maker,
            "Taker not allowed"
        );

        require(filledAmount[makerHash] + fillAmount <= makerOrder.amount, "Maker overfill");
        require(filledAmount[takerHash] + fillAmount <= takerOrder.amount, "Taker overfill");

        _checkCompliance(makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount);

        uint256 settlementPrice = makerOrder.isBuy ? takerOrder.price : makerOrder.price;
        uint256 quoteAmount     = fillAmount * settlementPrice / 1e18;

        // Fee routing:
        //   - Liquidation order: charge liquidationFeeBps, route to liquidationInsuranceFund (G-2/G-3)
        //   - Regular order:     charge takerFeeBps,       route to FeeCollector
        // Fee is zero if the respective bps is 0 (liquidationFeeBps defaults to 0 = disabled).
        uint256 fee;
        address feeReceiver; // address(0) = FeeCollector path; non-zero = InsuranceFund path
        if (makerOrder.isLiquidation) {
            // Charge fee only when BOTH feeBps > 0 AND insuranceFund is configured.
            // If either is missing, fee = 0 (full quote passes to seller, not FeeCollector).
            bool canRoute = liquidationFeeBps > 0 && liquidationInsuranceFund != address(0);
            fee         = canRoute ? quoteAmount * liquidationFeeBps / 10_000 : 0;
            feeReceiver = canRoute ? liquidationInsuranceFund : address(0);
        } else {
            fee         = quoteAmount * takerFeeBps / 10_000;
            feeReceiver = address(0); // FeeCollector path
        }

        // ── Effects ──
        filledAmount[makerHash] += fillAmount;
        filledAmount[takerHash] += fillAmount;

        if (filledAmount[makerHash] == makerOrder.amount) _useNonce(makerOrder.maker, makerOrder.nonce);
        if (filledAmount[takerHash] == takerOrder.amount) _useNonce(takerOrder.maker, takerOrder.nonce);

        // ── Interactions ──
        _executeTransfers(makerOrder, takerOrder, fillAmount, quoteAmount, fee, feeReceiver);

        compliance.onTradeSettled(makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount);

        emit OrderFilled(makerHash, makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount, fee);

        // Emit dedicated event when liquidation fee was deposited into InsuranceFund
        if (makerOrder.isLiquidation && fee > 0 && feeReceiver != address(0)) {
            bytes32 pairId = keccak256(abi.encodePacked(makerOrder.baseToken, makerOrder.quoteToken));
            emit LiquidationFeeRouted(pairId, makerOrder.quoteToken, fee);
        }
    }

    /// @dev Best-effort single funding payment. Silently skips on failure.
    function _trySettleFunding(FundingPayment calldata payment, address reserve) internal {
        if (payment.amount == 0 || payment.maker == address(0) || payment.quoteToken == address(0)) return;
        // Reject payments older than 9 hours (one funding interval + 1h grace)
        if (block.timestamp > payment.timestamp + 9 hours) return;
        // Guard: -type(int256).min would overflow; skip this pathological value
        if (payment.amount == type(int256).min) return;
        try this._externalSettleFunding(payment, reserve) {} catch {}
    }

    /// @dev External wrapper for try/catch — only callable from address(this).
    function _externalSettleFunding(
        FundingPayment calldata payment,
        address reserve
    ) external {
        // This function must remain `external` to support `try this._externalSettleFunding()`.
        // The msg.sender guard is the sole access control — do NOT remove or weaken it.
        require(msg.sender == address(this), "Internal only");

        if (payment.amount > 0) {
            // Maker receives — transfer from reserve to maker
            uint256 absAmount = uint256(payment.amount);
            IERC20(payment.quoteToken).safeTransferFrom(reserve, payment.maker, absAmount);
        } else {
            // Maker pays — transfer from maker to reserve
            uint256 absAmount = uint256(-payment.amount);
            IERC20(payment.quoteToken).safeTransferFrom(payment.maker, reserve, absAmount);
        }

        emit FundingSettled(payment.maker, payment.quoteToken, payment.amount, payment.pairId);
    }

    /// @dev Attempts to settle a single order pair; silently skips on failure (used in batch).
    function _trySettle(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256        fillAmount,
        bytes calldata makerSig,
        bytes calldata takerSig
    ) internal {
        try this._externalSettle(makerOrder, takerOrder, fillAmount, makerSig, takerSig) {}
        catch {}
    }

    /// @dev External wrapper for try/catch — only callable from address(this).
    function _externalSettle(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256        fillAmount,
        bytes calldata makerSig,
        bytes calldata takerSig
    ) external {
        require(msg.sender == address(this), "Internal only");
        _settle(makerOrder, takerOrder, fillAmount, makerSig, takerSig);
    }

    /// @dev Core settlement logic. Validates orders, checks compliance, moves tokens. CEI pattern.
    function _settle(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256        fillAmount,
        bytes calldata makerSig,
        bytes memory   takerSig
    ) internal {
        // ── Checks ──
        require(fillAmount > 0,                                 "Zero fill");
        require(block.timestamp < makerOrder.expiry,            "Maker expired");
        require(block.timestamp < takerOrder.expiry,            "Taker expired");
        require(makerOrder.isBuy != takerOrder.isBuy,           "Same direction");
        require(makerOrder.baseToken  == takerOrder.baseToken,  "Base mismatch");
        require(makerOrder.quoteToken == takerOrder.quoteToken, "Quote mismatch");

        // Price check: buy price >= sell price
        {
            uint256 buyPrice  = makerOrder.isBuy ? makerOrder.price : takerOrder.price;
            uint256 sellPrice = makerOrder.isBuy ? takerOrder.price : makerOrder.price;
            require(buyPrice >= sellPrice, "Price mismatch");
        }

        require(
            pairRegistry.isTradeAllowed(makerOrder.baseToken, makerOrder.quoteToken),
            "Pair not active"
        );

        bytes32 makerHash = hashOrder(makerOrder);
        bytes32 takerHash = hashOrder(takerOrder);

        _verifySignature(makerOrder.maker, makerHash, makerSig);
        if (takerSig.length > 0) {
            _verifySignature(takerOrder.maker, takerHash, takerSig);
        }

        require(
            makerOrder.taker == address(0) || makerOrder.taker == takerOrder.maker,
            "Taker not allowed"
        );

        require(filledAmount[makerHash] + fillAmount <= makerOrder.amount, "Maker overfill");
        require(filledAmount[takerHash] + fillAmount <= takerOrder.amount, "Taker overfill");

        _checkCompliance(makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount);

        // Settlement price = sell order price
        uint256 settlementPrice = makerOrder.isBuy ? takerOrder.price : makerOrder.price;
        uint256 quoteAmount = fillAmount * settlementPrice / 1e18;
        uint256 fee         = quoteAmount * takerFeeBps / 10_000;

        // ── Effects ──
        filledAmount[makerHash] += fillAmount;
        filledAmount[takerHash] += fillAmount;

        if (filledAmount[makerHash] == makerOrder.amount) _useNonce(makerOrder.maker, makerOrder.nonce);
        if (filledAmount[takerHash] == takerOrder.amount) _useNonce(takerOrder.maker, takerOrder.nonce);

        // ── Interactions ──
        // Regular orders always route fee to FeeCollector (feeReceiver=address(0))
        _executeTransfers(makerOrder, takerOrder, fillAmount, quoteAmount, fee, address(0));

        compliance.onTradeSettled(makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount);

        emit OrderFilled(makerHash, makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount, fee);
    }

    /// @dev Run compliance canTrade checks for both sides. Reverts if either fails.
    function _checkCompliance(
        address makerAddr,
        address takerAddr,
        address baseTokenAddr,
        uint256 fillAmount
    ) internal view {
        (bool makerOk, string memory mr) = compliance.canTrade(makerAddr, baseTokenAddr, fillAmount);
        require(makerOk, mr);
        (bool takerOk, string memory tr) = compliance.canTrade(takerAddr, baseTokenAddr, fillAmount);
        require(takerOk, tr);
    }

    /// @dev Execute token transfers for a settled order pair.
    /// @param feeReceiver address(0) = route fee to FeeCollector (regular orders).
    ///                    Non-zero   = route fee to that address via IInsuranceFundDeposit.deposit()
    ///                                 (liquidation orders → InsuranceFund). Requires that contract
    ///                                 has granted OPERATOR_ROLE to this settlement contract.
    function _executeTransfers(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256 fillAmount,
        uint256 quoteAmount,
        uint256 fee,
        address feeReceiver
    ) internal {
        address buyer  = makerOrder.isBuy ? makerOrder.maker : takerOrder.maker;
        address seller = makerOrder.isBuy ? takerOrder.maker : makerOrder.maker;

        IERC20(makerOrder.baseToken).safeTransferFrom(seller, buyer, fillAmount);
        IERC20(makerOrder.quoteToken).safeTransferFrom(buyer, seller, quoteAmount - fee);

        if (fee > 0) {
            IERC20(makerOrder.quoteToken).safeTransferFrom(buyer, address(this), fee);
            if (feeReceiver != address(0)) {
                // Liquidation fee → InsuranceFund
                // Requires: feeReceiver has granted OPERATOR_ROLE to address(this)
                bytes32 pairId = keccak256(abi.encodePacked(makerOrder.baseToken, makerOrder.quoteToken));
                IERC20(makerOrder.quoteToken).forceApprove(feeReceiver, fee);
                IInsuranceFundDeposit(feeReceiver).deposit(pairId, makerOrder.quoteToken, fee);
            } else {
                // Regular fee → FeeCollector
                IERC20(makerOrder.quoteToken).forceApprove(address(feeCollector), fee);
                feeCollector.depositFee(makerOrder.quoteToken, fee);
            }
        }
    }

    /// @dev Verifies an EIP-712 signature.
    ///      Accepts both direct signer and the signer's registered agent wallet (S-3-2).
    ///      Reverts with "Invalid maker signature" on failure.
    function _verifySignature(address signer, bytes32 hash, bytes memory sig) internal view {
        address recovered = ECDSA.recover(hash, sig);
        require(recovered == signer || recovered == agentOf[signer], "Invalid maker signature");
    }

    /// @dev Marks a nonce as used in the bitmap. Reverts if already used.
    function _useNonce(address user, uint256 nonce) internal {
        uint256 wordIndex = nonce >> 8;
        uint256 bitIndex  = nonce & 0xff;
        uint256 mask      = 1 << bitIndex;
        require(nonceBitmap[user][wordIndex] & mask == 0, "Nonce used");
        nonceBitmap[user][wordIndex] |= mask;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
