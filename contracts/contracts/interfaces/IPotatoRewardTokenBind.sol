// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @dev The single call the pad makes into a holder-rewards token, kept as a
///      standalone interface so {PotatoPad} does not have to import the full
///      contract (and carry its bytecode toward the EIP-170 ceiling).
///
///      V4 change: the token reads live fee growth from the {PoolManager}
///      singleton keyed by `poolId` (there is no per-pool contract to point at),
///      so `poolId` is bound here alongside the range. The manager address is an
///      immutable the token already holds.
interface IPotatoRewardTokenBind {
    function bindPosition(
        address locker,
        uint256 lpTokenId,
        bytes32 poolId,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper,
        bool quoteIsToken0,
        uint16 creatorBps
    ) external;
}
