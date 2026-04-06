// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title OracleAdmin
/// @notice Admin-controlled KRW exchange rate oracle with 2-hour timelock and delta guard.
/// @dev No public oracle exists for KRW. Rates are set by trusted operators and finalized
///      after a timelock. Admin can bypass timelock via setRateImmediate for emergencies.
///
///      Key invariants:
///      - Rates must be initialized before they can be proposed or applied.
///      - proposeRate enforces a delta guard (maxDeltaBps) against the current live rate.
///      - applyRate re-validates the delta guard against the current rate at apply time,
///        preventing a stale proposal from applying a now-invalid jump.
///      - setRateImmediate bypasses both timelock and delta guard — admin emergency only.
///      - Mark prices (postMarkPrice) are per trading pair and enforced within ±20% of the
///        previous posting to detect oracle manipulation attempts.
contract OracleAdmin is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /// @notice Role for accounts allowed to propose rates and post mark prices.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Live rate record for an ERC20 token (e.g. USDC → KRW).
    struct Rate {
        uint256 price;        // KRW per 1 token (18 decimals)
        uint256 updatedAt;    // Block timestamp of last applied/immediate update
        uint256 maxStaleness; // Seconds before rate is considered stale
        uint256 maxDeltaBps;  // Max allowed change per update (basis points, e.g. 500 = 5%)
    }

    /// @notice Pending rate awaiting timelock expiry.
    struct PendingRate {
        uint256 price;       // Proposed new price (18 decimals)
        uint256 effectiveAt; // block.timestamp after which applyRate may be called
    }

    /// @notice Minimum delay between proposeRate and applyRate.
    uint256 public constant TIMELOCK_DELAY = 2 hours;

    /// @notice Mark price snapshot for a trading pair.
    struct MarkPrice {
        uint256 price;       // 18 decimals
        uint256 timestamp;   // Block timestamp of last postMarkPrice call
    }

    /// @notice Live exchange rates indexed by token address.
    mapping(address => Rate)        public rates;

    /// @notice Pending proposed rates awaiting timelock. One slot per token.
    mapping(address => PendingRate) public pendingRates;

    /// @notice Latest mark prices per trading pair (keccak256 of pair string).
    mapping(bytes32 => MarkPrice)   public markPrices;

    /// @notice Emitted when an operator proposes a new rate for a token.
    /// @param token       Token whose rate is being updated.
    /// @param price       Proposed new price (18 decimals).
    /// @param effectiveAt Timestamp after which the rate may be applied.
    event RateProposed(address indexed token, uint256 price, uint256 effectiveAt);

    /// @notice Emitted when a proposed rate is applied after the timelock has elapsed.
    /// @param token Token whose rate was updated.
    /// @param price New live price (18 decimals).
    event RateApplied(address indexed token, uint256 price);

    /// @notice Emitted when admin sets a rate immediately, bypassing timelock.
    /// @param token Token whose rate was updated.
    /// @param price New live price (18 decimals).
    event RateSetImmediate(address indexed token, uint256 price);

    /// @notice Emitted when a token's rate is initialized for the first time.
    /// @param token Token being initialized.
    /// @param price Initial price (18 decimals).
    event RateInitialized(address indexed token, uint256 price);

    /// @notice Emitted when the mark price for a trading pair is posted.
    /// @param pairId    Trading pair identifier (keccak256 of pair string, e.g. keccak256("ETH/KRW")).
    /// @param price     Posted mark price (18 decimals).
    /// @param timestamp Block timestamp of the posting.
    event MarkPricePosted(bytes32 indexed pairId, uint256 price, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the oracle.
    /// @param admin Address granted DEFAULT_ADMIN_ROLE (governance multisig).
    function initialize(address admin) external initializer {
        __AccessControl_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Set the initial rate for a token. Can only be called once per token.
    /// @dev    Subsequent updates must go through proposeRate + applyRate or setRateImmediate.
    /// @param token          Token address (e.g. USDC). Must be non-zero.
    /// @param initialPrice   Initial KRW-per-token price (18 decimals, must be > 0 and ≤ uint128 max).
    /// @param maxStaleness   Seconds before getPrice() reverts with "Stale rate" (must be > 0).
    /// @param maxDeltaBps    Maximum allowed price change per update in bps (1–10000).
    function initializeRate(
        address token,
        uint256 initialPrice,
        uint256 maxStaleness,
        uint256 maxDeltaBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(token != address(0), "Zero address");
        require(initialPrice > 0, "Zero price");
        require(initialPrice <= type(uint128).max, "Price overflow");
        require(maxStaleness > 0, "Zero staleness");
        require(maxDeltaBps > 0 && maxDeltaBps <= 10_000, "Invalid delta bps");
        require(rates[token].price == 0, "Already initialized");
        rates[token] = Rate(initialPrice, block.timestamp, maxStaleness, maxDeltaBps);
        emit RateInitialized(token, initialPrice);
    }

    /// @notice Propose a new rate. Enforces delta guard. Effective after TIMELOCK_DELAY.
    /// @dev If a pending rate already exists, it is overwritten with the new proposal
    ///      and the timelock resets. This is intentional: the latest operator proposal wins.
    ///      Only OPERATOR_ROLE may call. Rate must be initialized first.
    /// @param token    Token to update.
    /// @param newPrice Proposed new KRW-per-token price (18 decimals, must be > 0 and ≤ uint128 max).
    function proposeRate(address token, uint256 newPrice) external onlyRole(OPERATOR_ROLE) {
        Rate storage r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(newPrice > 0, "Zero price");
        require(newPrice <= type(uint128).max, "Price overflow");
        _checkDelta(r.price, newPrice, r.maxDeltaBps);

        uint256 effectiveAt = block.timestamp + TIMELOCK_DELAY;
        pendingRates[token] = PendingRate(newPrice, effectiveAt);
        emit RateProposed(token, newPrice, effectiveAt);
    }

    /// @notice Apply a pending rate after timelock has elapsed. Anyone can call.
    /// @dev    Re-validates the delta guard against the current live rate at apply time.
    ///         This prevents a stale proposal from applying a jump that now exceeds maxDeltaBps.
    /// @param token Token whose pending rate to apply.
    function applyRate(address token) external {
        PendingRate memory pending = pendingRates[token];
        require(pending.price > 0, "No pending rate");
        require(block.timestamp >= pending.effectiveAt, "Timelock not elapsed");

        Rate storage r = rates[token];
        _checkDelta(r.price, pending.price, r.maxDeltaBps); // re-validate against current price

        r.price     = pending.price;
        r.updatedAt = block.timestamp;
        delete pendingRates[token];
        emit RateApplied(token, pending.price);
    }

    /// @notice Admin emergency override — bypasses timelock and delta guard.
    /// @dev    Use only for emergencies (e.g. stablecoin depeg, exchange halt).
    ///         Also clears any pending rate for the token.
    /// @param token    Token to update.
    /// @param newPrice New KRW-per-token price (18 decimals, must be > 0 and ≤ uint128 max).
    function setRateImmediate(address token, uint256 newPrice)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Rate storage r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(newPrice > 0, "Zero price");
        require(newPrice <= type(uint128).max, "Price overflow");
        r.price     = newPrice;
        r.updatedAt = block.timestamp;
        delete pendingRates[token];
        emit RateSetImmediate(token, newPrice);
    }

    /// @notice Returns current rate. Reverts if stale.
    /// @dev    Staleness is checked against rate.maxStaleness set at initializeRate time.
    ///         HybridPool calls this to obtain the oracle price for swap fallback.
    /// @param token The token address (e.g. USDC).
    /// @return price KRW per token (18 decimals).
    function getPrice(address token) external view returns (uint256) {
        Rate memory r = rates[token];
        require(r.price > 0, "Rate not initialized");
        require(block.timestamp - r.updatedAt <= r.maxStaleness, "Stale rate");
        return r.price;
    }

    /// @notice Post the current mark price for a trading pair.
    /// @dev Called by the operator just before executing liquidations.
    ///      Sanity check: price must be within ±20% of the last posted price (if any).
    ///      This guards against oracle manipulation that would incorrectly trigger liquidations.
    /// @param pairId  keccak256 of the pair string, e.g. keccak256("ETH/KRW").
    /// @param price   Mark price (18 decimals, must be > 0).
    function postMarkPrice(bytes32 pairId, uint256 price)
        external onlyRole(OPERATOR_ROLE)
    {
        require(price > 0, "zero price");
        MarkPrice storage mp = markPrices[pairId];
        if (mp.price > 0) {
            // Sanity check: new price must be within ±20% of last posted price
            uint256 delta = price > mp.price ? price - mp.price : mp.price - price;
            require(delta * 10_000 / mp.price <= 2_000, "price delta too large");
        }
        mp.price     = price;
        mp.timestamp = block.timestamp;
        emit MarkPricePosted(pairId, price, block.timestamp);
    }

    /// @notice Get the latest posted mark price for a pair.
    /// @dev    Returns (0, 0) if no mark price has ever been posted.
    ///         Callers should check timestamp to determine staleness.
    /// @param pairId  Trading pair identifier.
    /// @return price     Last posted mark price (18 decimals). 0 if never posted.
    /// @return timestamp Block timestamp of last post. 0 if never posted.
    function getMarkPrice(bytes32 pairId) external view returns (uint256 price, uint256 timestamp) {
        MarkPrice memory mp = markPrices[pairId];
        return (mp.price, mp.timestamp);
    }

    /// @dev Revert if the absolute change from current to newPrice exceeds maxDeltaBps.
    ///      Uses integer arithmetic: delta * 10_000 / current <= maxDeltaBps.
    function _checkDelta(uint256 current, uint256 newPrice, uint256 maxDeltaBps) internal pure {
        uint256 delta = newPrice > current ? newPrice - current : current - newPrice;
        require(delta * 10_000 / current <= maxDeltaBps, "Delta too large");
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
