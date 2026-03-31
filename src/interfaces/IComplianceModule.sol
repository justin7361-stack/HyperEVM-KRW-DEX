// src/interfaces/IComplianceModule.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IComplianceModule {
    /// @notice 거래 허용 여부 확인
    /// @param user  거래 주소
    /// @param token baseToken 주소
    /// @param amount baseToken 수량
    function canTrade(address user, address token, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason);

    /// @notice 스왑 허용 여부 확인
    /// @param user   스왑 주소
    /// @param amount quoteToken 수량
    function canSwap(address user, uint256 amount)
        external
        view
        returns (bool allowed, string memory reason);

    /// @notice 거래 체결 후 훅 (Travel Rule 연동 포인트)
    function onTradeSettled(
        address maker,
        address taker,
        address token,
        uint256 amount
    ) external;
}
