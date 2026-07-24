// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";

/// @title V4SingleSided
/// @notice Shared V4 plumbing for the Potato launchpads: single-sided liquidity
///         math (the amount→L conversions Uniswap's periphery would normally do),
///         canonical pool-key construction, and the settle/take helpers every
///         flash-accounting `unlockCallback` needs.
///
///         The launchpad seeds the ENTIRE token supply as one single-sided
///         position at a tick boundary, so exactly one of the two amount→L
///         conversions is ever used per launch (token0-only or token1-only).
library V4SingleSided {
    using SafeCast for uint256;

    /// @dev 2**96 — the Q64.96 fixed-point unit Uniswap prices are scaled by.
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /// @notice Builds the canonical (currency-sorted) pool key for a token/WETH
    ///         pair, and reports whether the launched token is currency0.
    /// @dev Hooks are always the zero address — these are vanilla pools; the whole
    ///      point of the pad is that there is nothing hidden in a hook.
    function poolKeyFor(address token, address weth, uint24 fee, int24 tickSpacing)
        internal
        pure
        returns (PoolKey memory key, bool tokenIs0)
    {
        tokenIs0 = token < weth;
        (address c0, address c1) = tokenIs0 ? (token, weth) : (weth, token);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(0))
        });
    }

    /// @notice The largest liquidity L a given `amount0` of token0 supports across
    ///         [sqrtA, sqrtB]. Mirrors Uniswap `LiquidityAmounts.getLiquidityForAmount0`,
    ///         so the amount0 that L actually consumes is guaranteed ≤ `amount0`.
    function liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0)
        internal
        pure
        returns (uint128 liquidity)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = Math.mulDiv(sqrtA, sqrtB, Q96);
        liquidity = Math.mulDiv(amount0, intermediate, sqrtB - sqrtA).toUint128();
    }

    /// @notice The largest liquidity L a given `amount1` of token1 supports across
    ///         [sqrtA, sqrtB]. Mirrors Uniswap `LiquidityAmounts.getLiquidityForAmount1`.
    function liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1)
        internal
        pure
        returns (uint128 liquidity)
    {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        liquidity = Math.mulDiv(amount1, Q96, sqrtB - sqrtA).toUint128();
    }

    /// @dev Pays `amount` of ERC-20 `currency` that this contract owes the manager:
    ///      sync → transfer from us → settle. Reverts unless the manager credits
    ///      exactly `amount`. Native currency is never used by the pad, so the
    ///      ERC-20 path is the only one needed.
    function settle(IPoolManager manager, Currency currency, uint256 amount) internal {
        manager.sync(currency);
        currency.transfer(address(manager), amount);
        manager.settle();
    }
}
