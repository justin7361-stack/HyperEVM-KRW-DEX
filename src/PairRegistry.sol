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
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        krwStablecoin = _krwStablecoin;
    }

    function addToken(address token, bool feeOnTransfer, bool rebase)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(token != address(0), "Zero address");
        tokens[token] = TokenInfo(true, feeOnTransfer, rebase);
        emit TokenWhitelisted(token);
    }

    function removeToken(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete tokens[token];
        emit TokenRemoved(token);
    }

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

    function setPairActive(bytes32 pairId, bool active) external onlyRole(OPERATOR_ROLE) {
        require(pairs[pairId].baseToken != address(0), "Pair not found");
        pairs[pairId].active = active;
        emit PairStatusChanged(pairId, active);
    }

    function updateKrwStablecoin(address newAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newAddress != address(0), "Zero address");
        krwStablecoin = newAddress;
        emit KrwStablecoinUpdated(newAddress);
    }

    function getPairId(address baseToken, address quoteToken) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(baseToken, quoteToken));
    }

    function isTradeAllowed(address baseToken, address quoteToken) external view returns (bool) {
        bytes32 pid    = getPairId(baseToken, quoteToken);
        Pair      memory p = pairs[pid];
        TokenInfo memory t = tokens[baseToken];
        return p.active && t.whitelisted && !t.feeOnTransfer && !t.rebase;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
