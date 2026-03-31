// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title OracleAdmin
/// @notice Admin-controlled KRW exchange rate oracle with 2-hour timelock and delta guard.
/// @dev No public oracle exists for KRW. Rates are set by trusted operators and finalized
///      after a timelock. Admin can bypass timelock via setRateImmediate for emergencies.
contract OracleAdmin is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    struct Rate {
        uint256 price;        // KRW per 1 token (18 decimals)
        uint256 updatedAt;
        uint256 maxStaleness; // seconds before rate is considered stale
        uint256 maxDeltaBps;  // max change allowed per update (basis points)
    }

    struct PendingRate {
        uint256 price;
        uint256 effectiveAt;
    }

    uint256 public constant TIMELOCK_DELAY = 2 hours;

    mapping(address => Rate)        public rates;
    mapping(address => PendingRate) public pendingRates;

    event RateProposed(address indexed token, uint256 price, uint256 effectiveAt);
    event RateApplied(address indexed token, uint256 price);
    event RateSetImmediate(address indexed token, uint256 price);
    event RateInitialized(address indexed token, uint256 price);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Set the initial rate for a token. Can only be called once per token.
    function initializeRate(
        address token,
        uint256 initialPrice,
        uint256 maxStaleness,
        uint256 maxDeltaBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0), "Zero address");
        require(initialPrice > 0, "Zero price");
        require(maxStaleness > 0, "Zero staleness");
        require(maxDeltaBps > 0 && maxDeltaBps <= 10_000, "Invalid delta bps");
        require(rates[token].price == 0, "Already initialized");
        rates[token] = Rate(initialPrice, block.timestamp, maxStaleness, maxDeltaBps);
        emit RateInitialized(token, initialPrice);
    }

    /// @notice Propose a new rate. Enforces delta guard. Effective after TIMELOCK_DELAY.
    function proposeRate(address token, uint256 newPrice) external onlyRole(OPERATOR_ROLE) {
        Rate storage r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(newPrice > 0, "Zero price");
        _checkDelta(r.price, newPrice, r.maxDeltaBps);

        uint256 effectiveAt = block.timestamp + TIMELOCK_DELAY;
        pendingRates[token] = PendingRate(newPrice, effectiveAt);
        emit RateProposed(token, newPrice, effectiveAt);
    }

    /// @notice Apply a pending rate after timelock has elapsed. Anyone can call.
    function applyRate(address token) external {
        PendingRate memory pending = pendingRates[token];
        require(pending.price > 0, "No pending rate");
        require(block.timestamp >= pending.effectiveAt, "Timelock not elapsed");

        rates[token].price     = pending.price;
        rates[token].updatedAt = block.timestamp;
        delete pendingRates[token];
        emit RateApplied(token, pending.price);
    }

    /// @notice Admin emergency override — bypasses timelock and delta guard.
    function setRateImmediate(address token, uint256 newPrice)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Rate storage r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(newPrice > 0, "Zero price");
        r.price     = newPrice;
        r.updatedAt = block.timestamp;
        delete pendingRates[token];
        emit RateSetImmediate(token, newPrice);
    }

    /// @notice Returns current rate. Reverts if stale.
    /// @param token The token address (e.g. USDC)
    /// @return price KRW per token (18 decimals)
    function getPrice(address token) external view returns (uint256) {
        Rate memory r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(block.timestamp - r.updatedAt <= r.maxStaleness, "Stale rate");
        return r.price;
    }

    function _checkDelta(uint256 current, uint256 newPrice, uint256 maxDeltaBps) internal pure {
        uint256 delta = newPrice > current ? newPrice - current : current - newPrice;
        require(delta * 10_000 / current <= maxDeltaBps, "Delta too large");
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
