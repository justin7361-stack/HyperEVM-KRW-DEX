// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title PairRegistry
/// @notice Authoritative on-chain registry of whitelisted tokens and active trading pairs.
///         The off-chain matching engine queries this contract to determine which pairs may be
///         settled and to build its internal pairId resolver map at startup.
/// @dev Key invariants:
///      - Only DEFAULT_ADMIN_ROLE may add or remove tokens and add trading pairs.
///      - Only OPERATOR_ROLE may toggle a pair's active status.
///      - quoteToken must always be the KRW stablecoin set at initialization.
///      - A pair that already exists cannot be re-added (baseToken slot check).
///      - Tokens with feeOnTransfer or rebase flags will fail the isTradeAllowed check,
///        preventing settlement of unsafe token types.
contract PairRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    /// @notice Role for accounts that can toggle pair active/inactive status.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Configuration for a registered trading pair.
    struct Pair {
        address baseToken;
        address quoteToken;
        uint256 tickSize;      // Minimum price increment (18 decimals)
        uint256 lotSize;       // Minimum quantity increment (18 decimals)
        uint256 minOrderSize;  // Minimum base token order size (18 decimals)
        uint256 maxOrderSize;  // Maximum base token order size (18 decimals)
        bool    active;        // False = pair is halted, settlement will revert
    }

    /// @notice Flags for a whitelisted token describing its transfer behaviour.
    struct TokenInfo {
        bool whitelisted;    // Must be true for the token to appear in any pair
        bool feeOnTransfer;  // True = token deducts a fee on transfer (blocked from trading)
        bool rebase;         // True = token rebases balances (blocked from trading)
    }

    /// @notice All registered pairs indexed by pairId.
    mapping(bytes32 => Pair)      public pairs;

    /// @notice Token whitelist metadata indexed by token address.
    mapping(address => TokenInfo) public tokens;

    /// @notice The KRW stablecoin address that must be the quoteToken for every pair.
    address public krwStablecoin;

    /// @notice Ordered list of all registered pairIds (active and inactive).
    /// @dev    Append-only. Used by getAllPairIds() for off-chain enumeration.
    bytes32[] public pairIds;

    /// @notice Emitted when a new trading pair is registered.
    /// @param pairId     keccak256(abi.encodePacked(baseToken, quoteToken)).
    /// @param baseToken  Base token address.
    /// @param quoteToken Quote token address (always krwStablecoin).
    event PairAdded(bytes32 indexed pairId, address baseToken, address quoteToken);

    /// @notice Emitted when a pair's active status changes.
    /// @param pairId Trading pair identifier.
    /// @param active New status (true = active, false = halted).
    event PairStatusChanged(bytes32 indexed pairId, bool active);

    /// @notice Emitted when a token is added to the whitelist.
    /// @param token The whitelisted token address.
    event TokenWhitelisted(address indexed token);

    /// @notice Emitted when a token is removed from the whitelist.
    /// @param token The removed token address.
    event TokenRemoved(address indexed token);

    /// @notice Emitted when the KRW stablecoin address is updated.
    /// @param newAddress New KRW stablecoin contract address.
    event KrwStablecoinUpdated(address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the registry.
    /// @param admin           Address granted DEFAULT_ADMIN_ROLE (governance multisig).
    /// @param _krwStablecoin  Address of the KRW stablecoin that must be the quoteToken in all pairs.
    function initialize(address admin, address _krwStablecoin) external initializer {
        __AccessControl_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        require(_krwStablecoin != address(0), "Zero address");
        krwStablecoin = _krwStablecoin;
    }

    /// @notice Whitelist a token for use as a base asset in trading pairs.
    /// @dev    feeOnTransfer and rebase tokens are recordable but will be blocked by isTradeAllowed.
    /// @param token          Token contract address.
    /// @param feeOnTransfer  True if the token charges a transfer fee.
    /// @param rebase         True if the token has elastic supply rebasing.
    function addToken(address token, bool feeOnTransfer, bool rebase)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(0), "Zero address");
        tokens[token] = TokenInfo(true, feeOnTransfer, rebase);
        emit TokenWhitelisted(token);
    }

    /// @notice Remove a token from the whitelist.
    /// @dev    Existing pairs referencing this token will fail isTradeAllowed after removal.
    /// @param token Token address to remove.
    function removeToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete tokens[token];
        emit TokenRemoved(token);
    }

    /// @notice Register a new trading pair. baseToken must be whitelisted; quoteToken must be krwStablecoin.
    /// @dev    Reverts if the pair already exists (identified by pairId). Once registered, a pair
    ///         is immediately active and cannot be re-registered even if later deactivated.
    /// @param baseToken    Whitelisted base token address.
    /// @param quoteToken   Must equal krwStablecoin.
    /// @param tickSize     Minimum price increment (18 decimals, must be > 0).
    /// @param lotSize      Minimum quantity increment (18 decimals, must be > 0).
    /// @param minOrderSize Minimum order size in base token (18 decimals, must be > 0).
    /// @param maxOrderSize Maximum order size in base token (must be > minOrderSize).
    function addPair(
        address baseToken,
        address quoteToken,
        uint256 tickSize,
        uint256 lotSize,
        uint256 minOrderSize,
        uint256 maxOrderSize
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(tokens[baseToken].whitelisted,  "Base token not whitelisted");
        require(quoteToken == krwStablecoin,    "Quote must be KRW stablecoin");
        require(tickSize > 0 && lotSize > 0,    "Invalid tick/lot size");
        require(minOrderSize > 0 && maxOrderSize > minOrderSize, "Invalid order sizes");

        bytes32 pid = getPairId(baseToken, quoteToken);
        require(pairs[pid].baseToken == address(0), "Pair exists");

        pairs[pid] = Pair(baseToken, quoteToken, tickSize, lotSize, minOrderSize, maxOrderSize, true);
        pairIds.push(pid);
        emit PairAdded(pid, baseToken, quoteToken);
    }

    /// @notice Enable or disable a trading pair. Operator only.
    /// @dev    Disabling a pair causes all subsequent settlement calls to revert via isTradeAllowed.
    /// @param pairId The pair to update.
    /// @param active True to enable, false to halt.
    function setPairActive(bytes32 pairId, bool active) external onlyRole(OPERATOR_ROLE) {
        require(pairs[pairId].baseToken != address(0), "Pair not found");
        pairs[pairId].active = active;
        emit PairStatusChanged(pairId, active);
    }

    /// @notice Update the KRW stablecoin address. Admin only.
    /// @dev    Does not retroactively update existing pairs. Only affects future addPair calls.
    /// @param newAddress New KRW stablecoin contract address.
    function updateKrwStablecoin(address newAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newAddress != address(0), "Zero address");
        krwStablecoin = newAddress;
        emit KrwStablecoinUpdated(newAddress);
    }

    /// @notice Compute the unique pair ID from base and quote token addresses.
    /// @dev    pairId = keccak256(abi.encodePacked(baseToken, quoteToken)).
    ///         Matches the formula used in OrderSettlement and OracleAdmin.
    /// @param baseToken  Base token address.
    /// @param quoteToken Quote token address.
    /// @return Unique pair identifier.
    function getPairId(address baseToken, address quoteToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    /// @notice Returns true if a trading pair is available and safe to trade.
    /// @dev Only baseToken flags are checked. quoteToken is always krwStablecoin,
    ///      which is admin-controlled and not expected to have feeOnTransfer/rebase.
    ///      Returns false (does not revert) when unsafe — caller should revert on false.
    /// @param baseToken  Base token address.
    /// @param quoteToken Quote token address.
    /// @return True if the pair is active, base token is whitelisted, and has no unsafe flags.
    function isTradeAllowed(address baseToken, address quoteToken) external view returns (bool) {
        bytes32 pid    = getPairId(baseToken, quoteToken);
        Pair      memory p = pairs[pid];
        TokenInfo memory t = tokens[baseToken];
        return p.active && t.whitelisted && !t.feeOnTransfer && !t.rebase;
    }

    /// @notice Returns all registered pair IDs (active and inactive).
    /// @dev Used by off-chain server at startup to build pairId resolver map.
    /// @return Array of all pairIds in registration order.
    function getAllPairIds() external view returns (bytes32[] memory) {
        return pairIds;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
