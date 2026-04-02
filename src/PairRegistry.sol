// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract PairRegistry is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    struct Pair {
        address baseToken;
        address quoteToken;
        uint256 tickSize;
        uint256 lotSize;
        uint256 minOrderSize;
        uint256 maxOrderSize;
        bool    active;
    }

    struct TokenInfo {
        bool whitelisted;
        bool feeOnTransfer;
        bool rebase;
    }

    mapping(bytes32 => Pair)      public pairs;
    mapping(address => TokenInfo) public tokens;
    address public krwStablecoin;
    bytes32[] public pairIds;

    event PairAdded(bytes32 indexed pairId, address baseToken, address quoteToken);
    event PairStatusChanged(bytes32 indexed pairId, bool active);
    event TokenWhitelisted(address indexed token);
    event TokenRemoved(address indexed token);
    event KrwStablecoinUpdated(address indexed newAddress);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address _krwStablecoin) external initializer {
        __AccessControl_init();
        require(admin != address(0), "Zero address");
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        require(_krwStablecoin != address(0), "Zero address");
        krwStablecoin = _krwStablecoin;
    }

    /// @notice Whitelist a token for use as a base asset in trading pairs.
    function addToken(address token, bool feeOnTransfer, bool rebase)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(0), "Zero address");
        tokens[token] = TokenInfo(true, feeOnTransfer, rebase);
        emit TokenWhitelisted(token);
    }

    /// @notice Remove a token from the whitelist.
    function removeToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete tokens[token];
        emit TokenRemoved(token);
    }

    /// @notice Register a new trading pair. baseToken must be whitelisted; quoteToken must be krwStablecoin.
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
    function setPairActive(bytes32 pairId, bool active) external onlyRole(OPERATOR_ROLE) {
        require(pairs[pairId].baseToken != address(0), "Pair not found");
        pairs[pairId].active = active;
        emit PairStatusChanged(pairId, active);
    }

    /// @notice Update the KRW stablecoin address. Admin only.
    function updateKrwStablecoin(address newAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newAddress != address(0), "Zero address");
        krwStablecoin = newAddress;
        emit KrwStablecoinUpdated(newAddress);
    }

    /// @notice Compute the unique pair ID from base and quote token addresses.
    function getPairId(address baseToken, address quoteToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    /// @notice Returns true if a trading pair is available and safe to trade.
    /// @dev Only baseToken flags are checked. quoteToken is always krwStablecoin,
    ///      which is admin-controlled and not expected to have feeOnTransfer/rebase.
    function isTradeAllowed(address baseToken, address quoteToken) external view returns (bool) {
        bytes32 pid    = getPairId(baseToken, quoteToken);
        Pair      memory p = pairs[pid];
        TokenInfo memory t = tokens[baseToken];
        return p.active && t.whitelisted && !t.feeOnTransfer && !t.rebase;
    }

    /// @notice Returns all registered pair IDs (active and inactive).
    /// @dev Used by off-chain server at startup to build pairId resolver map.
    function getAllPairIds() external view returns (bytes32[] memory) {
        return pairIds;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
