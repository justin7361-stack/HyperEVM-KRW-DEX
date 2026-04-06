// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MarginRegistry
/// @notice Authoritative on-chain record of all trader perpetual positions.
///         The off-chain matching engine writes positions here after each settlement batch.
///         Liquidation and ADL contracts read from it.
/// @dev Key invariants:
///      - Only OPERATOR_ROLE may write positions via updatePosition() or set quote tokens.
///      - Any trader with an open position may call addMargin() to top up their collateral.
///      - Only DEFAULT_ADMIN_ROLE may perform emergency withdrawals via withdrawMargin().
///      - GUARDIAN_ROLE can pause; only DEFAULT_ADMIN_ROLE can unpause (deliberate asymmetry).
///      - Closing a position (size == 0) requires margin == 0 to be set simultaneously.
///      - size == type(int256).min is rejected to prevent overflow when computing |size|.
///      - CROSS mode: all positions in the account share margin (tracked off-chain).
///      - ISOLATED mode: each position has its own margin bucket (the on-chain Position.margin).
///      - isUnderMargin() is a pure read — liquidation decision logic lives off-chain.
///      - CEI pattern is applied in addMargin().
contract MarginRegistry is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Role for the off-chain operator (matching engine) that updates positions.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role for accounts that can pause the contract (hot-wallet emergency key).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Margin mode for a position.
    /// @dev CROSS = shared margin across all positions in the account.
    ///      ISOLATED = dedicated margin per position; only this contract's margin bucket is used.
    enum MarginMode { CROSS, ISOLATED }

    /// @notice A trader's open position for a specific trading pair.
    struct Position {
        int256     size;         // positive = long, negative = short (18-decimal base token units)
        uint256    margin;       // quoteToken collateral allocated (18 decimals)
        MarginMode mode;         // CROSS or ISOLATED
        uint256    lastUpdated;  // block.timestamp of last updatePosition call
    }

    /// @notice All trader positions: positions[maker][pairId] => Position.
    /// @dev    Private to enforce access through getPosition(). Updated only by operator.
    mapping(address => mapping(bytes32 => Position)) private positions;

    /// @notice The ERC20 quote token for each pairId, used by addMargin() to pull collateral.
    /// @dev    Must be set by operator before traders can call addMargin for that pair.
    mapping(bytes32 => address) public quoteTokens;

    /// @notice Emitted when a trader's position is created, updated, or closed by the operator.
    /// @param maker  Trader address.
    /// @param pairId Trading pair identifier.
    /// @param size   New position size (positive = long, negative = short, 0 = closed).
    /// @param margin Collateral allocated to this position.
    /// @param mode   Margin mode (CROSS or ISOLATED).
    event PositionUpdated(address indexed maker, bytes32 indexed pairId, int256 size, uint256 margin, MarginMode mode);

    /// @notice Emitted when a trader tops up margin for their position.
    /// @param maker  Trader address.
    /// @param pairId Trading pair identifier.
    /// @param amount Amount of quoteToken added as margin.
    event MarginAdded(address indexed maker, bytes32 indexed pairId, uint256 amount);

    /// @notice Emitted when the operator registers a quote token for a pair.
    /// @param pairId Trading pair identifier.
    /// @param token  ERC20 token set as the quote currency for this pair.
    event QuoteTokenSet(bytes32 indexed pairId, address token);

    /// @notice Emitted when the admin makes an emergency withdrawal.
    /// @param token  ERC20 token withdrawn.
    /// @param to     Recipient address.
    /// @param amount Amount transferred.
    event MarginWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the margin registry.
    /// @param admin    Address granted DEFAULT_ADMIN_ROLE (governance multisig).
    /// @param operator Address granted OPERATOR_ROLE (off-chain matching engine).
    function initialize(address admin, address operator) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
    }

    /// @notice Register the ERC20 quote token for a trading pair.
    /// @dev Must be set before traders can call addMargin for that pair.
    ///      Typically matches the quoteToken registered in PairRegistry (KRW stablecoin).
    /// @param pairId The trading pair identifier.
    /// @param token  ERC20 token address to use as quote currency (must be non-zero).
    function setQuoteToken(bytes32 pairId, address token)
        external
        onlyRole(OPERATOR_ROLE)
    {
        require(token != address(0), "zero token");
        quoteTokens[pairId] = token;
        emit QuoteTokenSet(pairId, token);
    }

    /// @notice Record or overwrite a trader's position after settlement.
    /// @dev Called by the operator after each settleBatch() call on OrderSettlement.
    ///      Closing a position: pass size=0 and margin=0. Any other size=0 with margin>0 reverts.
    ///      size == type(int256).min is rejected to prevent overflow in isUnderMargin().
    /// @param maker   The trader address (must be non-zero).
    /// @param pairId  keccak256 of the pair string, e.g. keccak256("ETH/KRW").
    /// @param size    Net position size. Pass 0 to effectively close the position.
    /// @param margin  Collateral allocated. Must be 0 when size is 0.
    /// @param mode    CROSS or ISOLATED margin mode.
    function updatePosition(
        address maker,
        bytes32 pairId,
        int256  size,
        uint256 margin,
        MarginMode mode
    )
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
    {
        require(maker != address(0), "zero maker");
        require(size != type(int256).min, "invalid size");
        // If size is 0 the position is closed — margin must be 0 too
        if (size == 0) require(margin == 0, "margin must be zero when closed");

        positions[maker][pairId] = Position({
            size:        size,
            margin:      margin,
            mode:        mode,
            lastUpdated: block.timestamp
        });
        emit PositionUpdated(maker, pairId, size, margin, mode);
    }

    /// @notice Traders call this to top up margin for an open isolated position.
    /// @dev    Pulls ERC20 quoteToken from caller. quoteToken must be set for pairId.
    ///         Reverts if no open position exists (size == 0). CEI: state updated before transfer.
    ///         Protected by nonReentrant and whenNotPaused.
    /// @param pairId  The pair to add margin to.
    /// @param amount  Amount of quoteToken to add (18 decimals, must be > 0).
    function addMargin(bytes32 pairId, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        require(amount > 0, "zero amount");
        address token = quoteTokens[pairId];
        require(token != address(0), "quote token not set");

        Position storage pos = positions[msg.sender][pairId];
        require(pos.size != 0, "no open position");

        // CEI: update state before external call
        pos.margin      += amount;
        pos.lastUpdated  = block.timestamp;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit MarginAdded(msg.sender, pairId, amount);
    }

    /// @notice Read a trader's position for a pair.
    /// @param maker  Trader address.
    /// @param pairId Trading pair identifier.
    /// @return The stored Position struct (size, margin, mode, lastUpdated).
    function getPosition(address maker, bytes32 pairId)
        external
        view
        returns (Position memory)
    {
        return positions[maker][pairId];
    }

    /// @notice Check if a position is below the maintenance margin threshold.
    /// @dev    Used by the off-chain engine and liquidation logic to identify liquidatable positions.
    ///         Returns false (not revert) for closed positions (size == 0).
    ///         Formula: |size| * markPrice / 1e18 * maintenanceBps / 10000 > margin.
    /// @param maker           Trader address.
    /// @param pairId          Trading pair.
    /// @param markPrice       Current mark price (18 decimals).
    /// @param maintenanceBps  Maintenance margin ratio in basis points (e.g. 250 = 2.5%, must be > 0).
    /// @return True if the position is under-margined (liquidatable).
    function isUnderMargin(
        address maker,
        bytes32 pairId,
        uint256 markPrice,
        uint256 maintenanceBps
    ) external view returns (bool) {
        Position memory pos = positions[maker][pairId];
        if (pos.size == 0) return false;
        require(maintenanceBps > 0, "zero bps");

        uint256 absSize  = pos.size > 0 ? uint256(pos.size) : uint256(-pos.size);
        // notionalValue = |size| × markPrice / 1e18
        uint256 notional = absSize * markPrice / 1e18;
        // maintenanceMargin = notional × maintenanceBps / 10000
        uint256 maintenance = notional * maintenanceBps / 10_000;
        return pos.margin < maintenance;
    }

    /// @notice Emergency withdrawal of tokens held by this contract.
    /// @dev    DEFAULT_ADMIN_ROLE only. Intentionally omits whenNotPaused so admin can
    ///         recover funds regardless of pause state. No position balance tracking —
    ///         transfers raw ERC20 balance directly. Use with caution.
    /// @param token  ERC20 token to withdraw (must be non-zero).
    /// @param to     Recipient address (must be non-zero).
    /// @param amount Amount to transfer.
    function withdrawMargin(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(to != address(0), "zero recipient");
        require(amount > 0, "zero amount");
        IERC20(token).safeTransfer(to, amount);
        emit MarginWithdrawn(token, to, amount);
    }

    /// @notice Pause the contract. Only GUARDIAN_ROLE.
    /// @dev    Blocks updatePosition() and addMargin(). Does not block withdrawMargin().
    function pause() external onlyRole(GUARDIAN_ROLE) { _pause(); }

    /// @notice Unpause the contract. Only DEFAULT_ADMIN_ROLE.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @dev UUPS upgrade authorization — only DEFAULT_ADMIN_ROLE.
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
