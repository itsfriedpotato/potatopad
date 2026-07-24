// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

import {TickMath} from "../libraries/TickMath.sol";
import {V4SingleSided} from "../libraries/V4SingleSided.sol";

/// @dev Test-only convenience reader over the V4 singleton. V4 has no per-pool
///      contract, so the frontend/tests read pool state from the manager via
///      `StateLibrary` (extsload). This exposes exactly the reads the ported test
///      suites need, so a test can treat a `(manager, poolId)` pair like a V3 pool.
///      Also exposes the single-sided liquidity math (same library the pad uses) so
///      a test can seed an out-of-range position with a known token amount.
contract V4StateView {
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    constructor(IPoolManager manager_) {
        manager = manager_;
    }

    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)
    {
        return manager.getSlot0(PoolId.wrap(poolId));
    }

    function getLiquidity(bytes32 poolId) external view returns (uint128) {
        return manager.getLiquidity(PoolId.wrap(poolId));
    }

    function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper)
        external
        view
        returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)
    {
        return manager.getFeeGrowthInside(PoolId.wrap(poolId), tickLower, tickUpper);
    }

    function getPositionInfo(
        bytes32 poolId,
        address owner,
        int24 tickLower,
        int24 tickUpper,
        bytes32 salt
    ) external view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128) {
        return manager.getPositionInfo(PoolId.wrap(poolId), owner, tickLower, tickUpper, salt);
    }

    function getTickFeeGrowthOutside(bytes32 poolId, int24 tick)
        external
        view
        returns (uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128)
    {
        return manager.getTickFeeGrowthOutside(PoolId.wrap(poolId), tick);
    }

    /// @dev Liquidity a token0-only amount supports across [lower, upper] (same math
    ///      the pad seeds with). Lets a test add a known single-sided position.
    function liquidityForToken0(int24 lower, int24 upper, uint256 amount0) external pure returns (uint128) {
        return V4SingleSided.liquidityForAmount0(
            TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), amount0
        );
    }

    /// @dev Liquidity a token1-only amount supports across [lower, upper].
    function liquidityForToken1(int24 lower, int24 upper, uint256 amount1) external pure returns (uint128) {
        return V4SingleSided.liquidityForAmount1(
            TickMath.getSqrtRatioAtTick(lower), TickMath.getSqrtRatioAtTick(upper), amount1
        );
    }
}
