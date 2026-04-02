// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Vm.sol";
import "../../src/OrderSettlement.sol";

contract SigUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private immutable DOMAIN_SEPARATOR;
    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address taker,address baseToken,address quoteToken,"
        "uint256 price,uint256 amount,bool isBuy,uint256 nonce,uint256 expiry,bool isLiquidation)"
    );

    constructor(bytes32 domainSeparator) {
        DOMAIN_SEPARATOR = domainSeparator;
    }

    function sign(uint256 privateKey, OrderSettlement.Order memory order)
        external
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.maker, order.taker, order.baseToken, order.quoteToken,
            order.price, order.amount, order.isBuy, order.nonce, order.expiry,
            order.isLiquidation
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
