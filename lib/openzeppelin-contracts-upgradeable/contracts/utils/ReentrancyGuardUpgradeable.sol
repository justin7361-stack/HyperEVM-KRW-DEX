// SPDX-License-Identifier: MIT
// Minimal stub — the real file was not shipped in this lib snapshot.
pragma solidity ^0.8.24;

import {Initializable} from "../proxy/utils/Initializable.sol";

abstract contract ReentrancyGuardUpgradeable is Initializable {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;

    /// @custom:storage-location erc7201:openzeppelin.storage.ReentrancyGuard
    struct ReentrancyGuardStorage {
        uint256 _status;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ReentrancyGuard")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ReentrancyGuardStorageLocation =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;

    function _getReentrancyGuardStorage() private pure returns (ReentrancyGuardStorage storage $) {
        assembly { $.slot := ReentrancyGuardStorageLocation }
    }

    function __ReentrancyGuard_init() internal onlyInitializing {
        __ReentrancyGuard_init_unchained();
    }

    function __ReentrancyGuard_init_unchained() internal onlyInitializing {
        _getReentrancyGuardStorage()._status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        ReentrancyGuardStorage storage $ = _getReentrancyGuardStorage();
        require($._status != _ENTERED, "ReentrancyGuard: reentrant call");
        $._status = _ENTERED;
        _;
        $._status = _NOT_ENTERED;
    }
}
