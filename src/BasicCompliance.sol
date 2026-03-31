// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./interfaces/IComplianceModule.sol";

/// @title BasicCompliance
/// @notice MVP compliance module: address blocklist + optional geo-block.
/// @dev Implements IComplianceModule. Can be swapped for AdvancedCompliance without
///      redeploying OrderSettlement or HybridPool (just call setComplianceModule on each).
contract BasicCompliance is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    IComplianceModule
{
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Addresses blocked from trading and swapping
    mapping(address => bool) public blocked;
    /// @notice Per-address geo-block flag (only enforced when geoBlockEnabled == true)
    mapping(address => bool) public geoBlocked;
    /// @notice Global geo-block switch
    bool public geoBlockEnabled;

    event AddressBlocked(address indexed addr);
    event AddressUnblocked(address indexed addr);
    event GeoBlockSet(address indexed addr, bool isBlocked);
    event GeoBlockToggled(bool enabled);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Block an address from trading. Operator can block, only admin can unblock.
    function blockAddress(address addr) external onlyRole(OPERATOR_ROLE) {
        blocked[addr] = true;
        emit AddressBlocked(addr);
    }

    /// @notice Unblock an address. Admin only — deliberate asymmetry with blockAddress.
    function unblockAddress(address addr) external onlyRole(DEFAULT_ADMIN_ROLE) {
        blocked[addr] = false;
        emit AddressUnblocked(addr);
    }

    /// @notice Mark an address as geo-blocked. Effective only when geoBlockEnabled == true.
    function setGeoBlock(address addr, bool isBlocked) external onlyRole(OPERATOR_ROLE) {
        geoBlocked[addr] = isBlocked;
        emit GeoBlockSet(addr, isBlocked);
    }

    /// @notice Enable or disable geo-blocking globally. Admin only.
    function toggleGeoBlock(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        geoBlockEnabled = enabled;
        emit GeoBlockToggled(enabled);
    }

    /// @inheritdoc IComplianceModule
    function canTrade(address user, address /*token*/, uint256 /*amount*/)
        external
        view
        override
        returns (bool allowed, string memory reason)
    {
        return _check(user);
    }

    /// @inheritdoc IComplianceModule
    function canSwap(address user, uint256 /*amount*/)
        external
        view
        override
        returns (bool allowed, string memory reason)
    {
        return _check(user);
    }

    /// @inheritdoc IComplianceModule
    /// @dev No-op in BasicCompliance. Travel Rule hooks to be added in AdvancedCompliance.
    function onTradeSettled(address, address, address, uint256) external override {}

    function _check(address user) internal view returns (bool, string memory) {
        if (blocked[user])                       return (false, "Blocked address");
        if (geoBlockEnabled && geoBlocked[user]) return (false, "Geo blocked");
        return (true, "");
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
