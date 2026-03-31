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
contract FeeCollector is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    /// @notice Total fees accumulated per token
    mapping(address => uint256) public accumulatedFees;

    event FeeDeposited(address indexed token, uint256 amount);
    event FeeWithdrawn(address indexed token, address indexed to, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        __ReentrancyGuard_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Deposit fees from a trusted caller (OrderSettlement, HybridPool).
    /// @dev Uses safeTransferFrom — caller must approve this contract first.
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
