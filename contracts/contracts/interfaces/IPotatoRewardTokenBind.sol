// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev The single call the pad makes into a holder-rewards token, kept as a
///      standalone interface so {PotatoPad} does not have to import the full
///      contract (and carry its bytecode toward the EIP-170 ceiling).
interface IPotatoRewardTokenBind {
    function bindPosition(
        address locker,
        uint256 lpTokenId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        bool wethIsToken0,
        uint16 creatorBps
    ) external;
}
