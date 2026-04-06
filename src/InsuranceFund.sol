// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title InsuranceFund
/// @notice Holds protocol collateral to cover liquidation losses and ADL-collected funds.
///         When the fund is exhausted during a cover() call, emits InsuranceFundExhausted
///         to signal that Auto-Deleveraging (ADL) must be triggered by the operator.
/// @dev Key invariants:
///      - Only OPERATOR_ROLE may deposit or request coverage (cover()).
///      - Only DEFAULT_ADMIN_ROLE may make emergency withdrawals.
///      - Balances are tracked per (pairId, token) — isolated per market.
///      - Partial coverage is allowed: cover() pays as much as available, then emits shortfall.
///      - InsuranceFundExhausted signals ADL — operator must call OrderSettlement.settleADL().
///      - Emergency withdrawal (withdraw) intentionally omits whenNotPaused so admin can
///        recover funds regardless of pause state.
///      - GUARDIAN_ROLE can pause; only DEFAULT_ADMIN_ROLE can unpause (deliberate asymmetry).
///      - CEI pattern is applied in all mutating functions.
contract InsuranceFund is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Role for accounts permitted to deposit into and request coverage from the fund.
    /// @dev    Held by OrderSettlement (for liquidation fee routing and ADL deposit).
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Role for accounts that can pause the contract (hot-wallet emergency key).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Accumulated balance per (pairId => token => amount).
    /// @dev    Private to prevent direct manipulation; exposed via getBalance().
    mapping(bytes32 => mapping(address => uint256)) private balances;

    /// @notice Emitted when tokens are deposited into the fund for a pair.
    /// @param pairId  Trading pair identifier.
    /// @param token   ERC20 token deposited.
    /// @param from    Address that deposited (msg.sender, i.e. the operator).
    /// @param amount  Amount deposited.
    event Deposited(bytes32 indexed pairId, address indexed token, address indexed from, uint256 amount);

    /// @notice Emitted when a cover() call is processed.
    /// @param pairId    Trading pair identifier.
    /// @param token     ERC20 token used for coverage.
    /// @param loss      Total loss amount requested.
    /// @param covered   Amount actually covered (≤ loss).
    /// @param shortfall Unmet remainder (0 if fully covered).
    event CoverUsed(bytes32 indexed pairId, address indexed token, uint256 loss, uint256 covered, uint256 shortfall);

    /// @notice Emitted when the fund cannot fully cover a loss (shortfall > 0).
    /// @dev    Signals that ADL must be triggered: operator should call OrderSettlement.settleADL().
    /// @param pairId    Trading pair identifier.
    /// @param token     ERC20 token that was exhausted.
    /// @param shortfall Remaining uncovered loss amount.
    event InsuranceFundExhausted(bytes32 indexed pairId, address indexed token, uint256 shortfall);

    /// @notice Emitted when the admin performs an emergency withdrawal.
    /// @param pairId  Trading pair identifier.
    /// @param token   ERC20 token withdrawn.
    /// @param to      Recipient address.
    /// @param amount  Amount withdrawn.
    event Withdrawn(bytes32 indexed pairId, address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the insurance fund.
    /// @param admin    Address granted DEFAULT_ADMIN_ROLE (governance multisig).
    /// @param operator Address granted OPERATOR_ROLE (OrderSettlement contract).
    /// @param guardian Address granted GUARDIAN_ROLE (hot-wallet pause key).
    function initialize(address admin, address operator, address guardian) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        require(admin    != address(0), "Zero address");
        require(operator != address(0), "Zero address");
        require(guardian != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE,      operator);
        _grantRole(GUARDIAN_ROLE,      guardian);
    }

    /// @notice Deposit tokens into the insurance fund for a specific trading pair.
    /// @dev    Caller must approve this contract to spend `amount` of `token` before calling.
    ///         Requires OPERATOR_ROLE. CEI: balance updated before ERC20 transfer.
    ///         Called by OrderSettlement after ADL collection and after liquidation fee routing.
    /// @param pairId Identifier for the trading pair (keccak256 of baseToken + quoteToken).
    /// @param token  ERC20 token address (must be non-zero).
    /// @param amount Amount to deposit (must be > 0).
    function deposit(bytes32 pairId, address token, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        require(token  != address(0), "Zero address");
        require(amount > 0,           "Zero amount");
        // CEI: Effects before Interactions (IMP-3 fix — previously had transfer before state update)
        balances[pairId][token] += amount;
        // Interactions
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(pairId, token, msg.sender, amount);
    }

    /// @notice Attempt to cover a liquidation loss from the fund.
    /// @dev    Partial coverage is allowed — covers as much as available, emits
    ///         InsuranceFundExhausted with the unmet shortfall if insufficient.
    ///         When shortfall > 0, the operator must trigger ADL via OrderSettlement.settleADL().
    ///         Requires OPERATOR_ROLE. CEI: balance updated before transfer.
    /// @param pairId Identifier for the trading pair.
    /// @param token  ERC20 token address (must be non-zero).
    /// @param loss   Amount needed to cover the loss. Returns (0,0) if loss == 0.
    /// @return covered   Actual amount covered (≤ loss). Transferred to msg.sender.
    /// @return shortfall Uncovered remainder (0 if fully covered).
    function cover(bytes32 pairId, address token, uint256 loss)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
        returns (uint256 covered, uint256 shortfall)
    {
        require(token != address(0), "Zero address");
        if (loss == 0) return (0, 0);

        uint256 balance = balances[pairId][token];
        covered   = balance >= loss ? loss : balance;
        shortfall = loss - covered;

        // Effects
        balances[pairId][token] = balance - covered;

        // Interactions
        if (covered > 0) {
            IERC20(token).safeTransfer(msg.sender, covered);
        }

        emit CoverUsed(pairId, token, loss, covered, shortfall);

        if (shortfall > 0) {
            emit InsuranceFundExhausted(pairId, token, shortfall);
        }
    }

    /// @notice Emergency withdrawal by admin.
    /// @dev Intentionally omits `whenNotPaused` — emergency withdrawal remains available
    ///      to DEFAULT_ADMIN_ROLE regardless of pause state.
    ///      CEI: balance updated before ERC20 transfer.
    /// @param pairId Identifier for the trading pair.
    /// @param token  ERC20 token address (must be non-zero).
    /// @param to     Recipient address (must be non-zero).
    /// @param amount Amount to withdraw (must be > 0 and ≤ current balance for the pair/token).
    function withdraw(bytes32 pairId, address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(token  != address(0), "Zero address");
        require(to     != address(0), "Zero address");
        require(amount > 0,           "Zero amount");
        require(balances[pairId][token] >= amount, "Insufficient balance");
        // Effects before Interactions
        balances[pairId][token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(pairId, token, to, amount);
    }

    /// @notice Get current fund balance for a pair and token.
    /// @dev    Used by OrderSettlement.settleADL() to verify the fund is exhausted (balance == 0)
    ///         before proceeding with auto-deleveraging.
    /// @param pairId Identifier for the trading pair.
    /// @param token  ERC20 token address.
    /// @return Current tracked balance for this pair/token.
    function getBalance(bytes32 pairId, address token) external view returns (uint256) {
        return balances[pairId][token];
    }

    /// @notice Pause the contract. Only GUARDIAN_ROLE.
    /// @dev    Blocks deposit() and cover(). Does not block emergency withdraw().
    function pause()   external onlyRole(GUARDIAN_ROLE)      { _pause(); }

    /// @notice Unpause the contract. Only DEFAULT_ADMIN_ROLE.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @dev UUPS upgrade authorization — only DEFAULT_ADMIN_ROLE.
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
