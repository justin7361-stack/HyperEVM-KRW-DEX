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

/// @title OrderSettlement
/// @notice CLOB DEX settlement contract. Operators submit matched maker/taker orders
///         with EIP-712 signatures. Bitmap nonces allow non-sequential cancel.
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

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address taker,address baseToken,address quoteToken,"
        "uint256 price,uint256 amount,bool isBuy,uint256 nonce,uint256 expiry)"
    );

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
    }

    /// @notice A single funding payment record — positive amount = maker receives, negative = maker pays
    struct FundingPayment {
        address maker;
        address quoteToken; // token transferred (KRW stablecoin)
        int256  amount;     // scaled by 1e18; positive = receives, negative = pays
        bytes32 pairId;
        uint256 timestamp;
    }

    /// @dev nonceBitmap[user][wordIndex] = bitmap of used nonces
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;
    /// @dev filledAmount[orderHash] = total base amount filled
    mapping(bytes32 => uint256) public filledAmount;

    IComplianceModule public compliance;
    PairRegistry      public pairRegistry;
    FeeCollector      public feeCollector;
    uint256           public takerFeeBps;

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address baseToken,
        uint256 fillAmount,
        uint256 fee
    );
    event OrderCancelled(address indexed user, uint256 nonce);
    event ComplianceUpdated(address indexed newModule);
    event TakerFeeUpdated(uint256 newFeeBps);
    event FundingSettled(address indexed maker, address indexed quoteToken, int256 amount, bytes32 pairId);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

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

    /// @notice Cancel a single order nonce.
    function cancelOrder(uint256 nonce) external {
        _useNonce(msg.sender, nonce);
        emit OrderCancelled(msg.sender, nonce);
    }

    /// @notice Cancel multiple nonces in one tx.
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
    /// @param payments  Array of funding payment records
    /// @param reserve   Address holding protocol funds for outgoing payments
    function settleFunding(
        FundingPayment[] calldata payments,
        address reserve
    ) external onlyRole(OPERATOR_ROLE) nonReentrant whenNotPaused {
        require(reserve != address(0), "Zero reserve");
        for (uint256 i = 0; i < payments.length; i++) {
            _trySettleFunding(payments[i], reserve);
        }
    }

    // ─────────────────────────────────────────────
    //  View
    // ─────────────────────────────────────────────

    function hashOrder(Order calldata order) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.maker, order.taker, order.baseToken, order.quoteToken,
            order.price, order.amount, order.isBuy, order.nonce, order.expiry
        )));
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        uint256 wordIndex = nonce >> 8;
        uint256 bitIndex  = nonce & 0xff;
        return nonceBitmap[user][wordIndex] & (1 << bitIndex) != 0;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─────────────────────────────────────────────
    //  Admin
    // ─────────────────────────────────────────────

    function setComplianceModule(address newModule) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newModule != address(0), "Zero address");
        compliance = IComplianceModule(newModule);
        emit ComplianceUpdated(newModule);
    }

    function setTakerFee(uint256 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newFeeBps <= 100, "Fee too high");
        takerFeeBps = newFeeBps;
        emit TakerFeeUpdated(newFeeBps);
    }

    /// @notice GUARDIAN can pause; only ADMIN can unpause (deliberate asymmetry).
    function pause()   external onlyRole(GUARDIAN_ROLE)      { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ─────────────────────────────────────────────
    //  Internal
    // ─────────────────────────────────────────────

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
        _executeTransfers(makerOrder, takerOrder, fillAmount, quoteAmount, fee);

        compliance.onTradeSettled(makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount);

        emit OrderFilled(makerHash, makerOrder.maker, takerOrder.maker, makerOrder.baseToken, fillAmount, fee);
    }

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

    function _executeTransfers(
        Order calldata makerOrder,
        Order calldata takerOrder,
        uint256 fillAmount,
        uint256 quoteAmount,
        uint256 fee
    ) internal {
        address buyer  = makerOrder.isBuy ? makerOrder.maker : takerOrder.maker;
        address seller = makerOrder.isBuy ? takerOrder.maker : makerOrder.maker;

        IERC20(makerOrder.baseToken).safeTransferFrom(seller, buyer, fillAmount);
        IERC20(makerOrder.quoteToken).safeTransferFrom(buyer, seller, quoteAmount - fee);

        if (fee > 0) {
            IERC20(makerOrder.quoteToken).safeTransferFrom(buyer, address(this), fee);
            IERC20(makerOrder.quoteToken).forceApprove(address(feeCollector), fee);
            feeCollector.depositFee(makerOrder.quoteToken, fee);
        }
    }

    /// @dev Verifies an EIP-712 signature. Reverts with "Invalid maker signature" on failure.
    function _verifySignature(address signer, bytes32 hash, bytes memory sig) internal pure {
        require(ECDSA.recover(hash, sig) == signer, "Invalid maker signature");
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
