// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FeeCollector
/// @notice Accumulates trading fees deposited by OrderSettlement and HybridPool.
///         Admin can withdraw to a designated treasury address.
/// @dev Key invariants:
///      - Only DEPOSITOR_ROLE may call depositFee (granted to OrderSettlement and HybridPool).
///      - Only DEFAULT_ADMIN_ROLE may withdraw accumulated fees.
///      - accumulatedFees[token] tracks the protocol's claimed balance, separate from raw ERC20 balance.
///      - CEI pattern is applied: state updated before external transfer in both deposit and withdraw.
///      - ReentrancyGuard protects both mutating functions.
contract FeeCollector is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    /// @notice Role for contracts permitted to deposit fees (OrderSettlement, HybridPool).
    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    /// @notice Total fees accumulated per token address.
    /// @dev    Monotonically increases on deposit, decreases on withdrawal.
    ///         Does not reflect raw ERC20 balance if tokens are accidentally sent directly.
    mapping(address => uint256) public accumulatedFees;

    /// @notice Emitted when fees are deposited by a trusted caller.
    /// @param token  ERC20 token address.
    /// @param amount Amount deposited (18 decimals for KRW stablecoins; native decimals otherwise).
    event FeeDeposited(address indexed token, uint256 amount);

    /// @notice Emitted when the admin withdraws accumulated fees.
    /// @param token  ERC20 token address.
    /// @param to     Recipient address (treasury).
    /// @param amount Amount withdrawn.
    event FeeWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the fee collector.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE (governance multisig or treasury controller).
    function initialize(address admin) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Deposit fees from a trusted caller (OrderSettlement, HybridPool).
    /// @dev    Caller must first approve this contract to spend `amount` of `token`.
    ///         Uses safeTransferFrom — reverts on failure. CEI: state updated before transfer.
    ///         Requires DEPOSITOR_ROLE.
    /// @param token  ERC20 token address to deposit (must be non-zero).
    /// @param amount Amount to deposit (must be > 0).
    function depositFee(address token, uint256 amount)
        external
        onlyRole(DEPOSITOR_ROLE)
        nonReentrant
    {
        require(token != address(0), "Zero address");
        require(amount > 0, "Zero amount");
        accumulatedFees[token] += amount;  // Effect before Interaction
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit FeeDeposited(token, amount);
    }

    /// @notice Withdraw accumulated fees to a recipient. CEI pattern.
    /// @dev    Only DEFAULT_ADMIN_ROLE. Reverts if insufficient accumulated balance.
    ///         Note: accumulatedFees[token] must cover the requested amount — it is not
    ///         based on raw ERC20 balance.
    /// @param token  ERC20 token to withdraw.
    /// @param to     Recipient address (must be non-zero).
    /// @param amount Amount to withdraw (must be > 0 and ≤ accumulatedFees[token]).
    function withdrawFee(address token, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        require(to != address(0), "Zero address");
        require(amount > 0, "Zero amount");
        require(accumulatedFees[token] >= amount, "Insufficient fees");
        accumulatedFees[token] -= amount;  // Effect before Interaction
        IERC20(token).safeTransfer(to, amount);
        emit FeeWithdrawn(token, to, amount);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
