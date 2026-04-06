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
/// @notice Holds protocol collateral to cover liquidation losses.
///         When the fund is exhausted, emits InsuranceFundExhausted to trigger ADL.
contract InsuranceFund is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Accumulated balance per pair per token
    mapping(bytes32 => mapping(address => uint256)) private balances;

    event Deposited(bytes32 indexed pairId, address indexed token, address indexed from, uint256 amount);
    event CoverUsed(bytes32 indexed pairId, address indexed token, uint256 loss, uint256 covered, uint256 shortfall);
    event InsuranceFundExhausted(bytes32 indexed pairId, address indexed token, uint256 shortfall);
    event Withdrawn(bytes32 indexed pairId, address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the insurance fund.
    /// @param admin    Address granted DEFAULT_ADMIN_ROLE.
    /// @param operator Address granted OPERATOR_ROLE.
    /// @param guardian Address granted GUARDIAN_ROLE.
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

    /// @notice Deposit tokens into the insurance fund.
    /// @dev    Caller must approve this contract. Requires OPERATOR_ROLE.
    /// @param pairId Identifier for the trading pair.
    /// @param token  ERC20 token address.
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
    ///         Requires OPERATOR_ROLE.
    /// @param pairId Identifier for the trading pair.
    /// @param token ERC20 token address.
    /// @param loss  Amount needed to cover the loss.
    /// @return covered   Actual amount covered (≤ loss).
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
    /// @param pairId Identifier for the trading pair.
    /// @param token  ERC20 token address.
    /// @param to     Recipient address.
    /// @param amount Amount to withdraw (must be > 0 and ≤ balance).
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
    /// @param pairId Identifier for the trading pair.
    /// @param token ERC20 token address.
    /// @return Current tracked balance.
    function getBalance(bytes32 pairId, address token) external view returns (uint256) {
        return balances[pairId][token];
    }

    /// @notice Pause the contract. Only GUARDIAN_ROLE.
    function pause()   external onlyRole(GUARDIAN_ROLE)      { _pause(); }

    /// @notice Unpause the contract. Only DEFAULT_ADMIN_ROLE.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    /// @dev UUPS upgrade authorization — only DEFAULT_ADMIN_ROLE.
    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
