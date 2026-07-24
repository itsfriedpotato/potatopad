"use client";

// Uniswap V4 primitives for the frontend data layer. V4 has no per-pair pool
// CONTRACT — all pools live in the singleton PoolManager and are identified by a
// `poolId` (keccak of the PoolKey). Reads go through the periphery `StateView`
// (getSlot0 / getLiquidity by poolId) and the `V4Quoter`; there is no `pool.slot0()`.

import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { ZERO_ADDRESS } from "@/lib/config";

/** The pad launches every token into the 1% fee tier at tick spacing 200, no hooks. */
export const POOL_FEE = 10_000;
export const TICK_SPACING = 200;
export const HOOKS: Address = ZERO_ADDRESS;

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Canonical (currency-sorted) pool key for a token/WETH pair + whether token is currency0. */
export function poolKeyFor(token: Address, weth: Address): { key: PoolKey; tokenIs0: boolean } {
  const tokenIs0 = BigInt(token) < BigInt(weth);
  const [currency0, currency1] = tokenIs0 ? [token, weth] : [weth, token];
  return {
    key: { currency0, currency1, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: HOOKS },
    tokenIs0,
  };
}

/**
 * The V4 pool id — keccak256 of the pool key. Mirrors v4-core `PoolIdLibrary.toId`
 * (a hash of the 5 struct slots), which `abi.encode` of these exact types
 * reproduces. Cross-checked on-chain against `PotatoPad.tokens(token).poolId`.
 */
export function computePoolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** The V4 pool id for a launched token/WETH pair. */
export function poolIdFor(token: Address, weth: Address): Hex {
  return computePoolId(poolKeyFor(token, weth).key);
}

// ---------------------------------------------------------------------------
// StateView — read pool state from the singleton by poolId (replaces pool.slot0())
// ---------------------------------------------------------------------------

export const stateViewAbi = [
  {
    inputs: [{ internalType: "PoolId", name: "poolId", type: "bytes32" }],
    name: "getSlot0",
    outputs: [
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { internalType: "int24", name: "tick", type: "int24" },
      { internalType: "uint24", name: "protocolFee", type: "uint24" },
      { internalType: "uint24", name: "lpFee", type: "uint24" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "PoolId", name: "poolId", type: "bytes32" }],
    name: "getLiquidity",
    outputs: [{ internalType: "uint128", name: "liquidity", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "PoolId", name: "poolId", type: "bytes32" },
      { internalType: "int24", name: "tickLower", type: "int24" },
      { internalType: "int24", name: "tickUpper", type: "int24" },
    ],
    name: "getFeeGrowthInside",
    outputs: [
      { internalType: "uint256", name: "feeGrowthInside0X128", type: "uint256" },
      { internalType: "uint256", name: "feeGrowthInside1X128", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * The V4 PoolManager `Swap` event. Unlike V3 (one event per pool contract), the
 * singleton emits ALL swaps keyed by the indexed `id` (poolId). `amount0`/`amount1`
 * are the SWAPPER's balance delta: negative = paid into the pool, positive =
 * received — the OPPOSITE sign convention from V3's pool-perspective event.
 */
export const v4SwapEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "PoolId", name: "id", type: "bytes32" },
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: false, internalType: "int128", name: "amount0", type: "int128" },
      { indexed: false, internalType: "int128", name: "amount1", type: "int128" },
      { indexed: false, internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, internalType: "uint128", name: "liquidity", type: "uint128" },
      { indexed: false, internalType: "int24", name: "tick", type: "int24" },
      { indexed: false, internalType: "uint24", name: "fee", type: "uint24" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;

// ---------------------------------------------------------------------------
// V4Quoter — accurate buy/sell estimates that account for the pool's price impact
// ---------------------------------------------------------------------------

/**
 * V4Quoter `quoteExactInputSingle`. Marked `view` here so wagmi's read hooks
 * accept it — the real contract is `nonpayable` but is designed to be called via
 * `eth_call` (exactly what a read does), same trick the V3 QuoterV2 used.
 */
export const v4QuoterAbi = [
  {
    inputs: [
      {
        components: [
          {
            components: [
              { internalType: "Currency", name: "currency0", type: "address" },
              { internalType: "Currency", name: "currency1", type: "address" },
              { internalType: "uint24", name: "fee", type: "uint24" },
              { internalType: "int24", name: "tickSpacing", type: "int24" },
              { internalType: "contract IHooks", name: "hooks", type: "address" },
            ],
            internalType: "struct PoolKey",
            name: "poolKey",
            type: "tuple",
          },
          { internalType: "bool", name: "zeroForOne", type: "bool" },
          { internalType: "uint128", name: "exactAmount", type: "uint128" },
          { internalType: "bytes", name: "hookData", type: "bytes" },
        ],
        internalType: "struct IV4Quoter.QuoteExactSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      { internalType: "uint256", name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Price math (unchanged from V3 — sqrtPriceX96 semantics are identical)
// ---------------------------------------------------------------------------

const Q96 = 2 ** 96;

/** True iff `token` sorts as currency0 in a token/WETH pool (token address < weth). */
export function tokenIsToken0(token: Address, weth: Address): boolean {
  return BigInt(token) < BigInt(weth);
}

/**
 * WETH per whole token from a pool sqrtPriceX96. Uniswap's raw price is currency1
 * per currency0; both assets are 18-decimals, so the wei ratio equals the
 * whole-token ratio. Invert when the launched token is currency1.
 */
export function priceWethPerToken(sqrtPriceX96: bigint, isToken0: boolean): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = Number(sqrtPriceX96) / Q96; // sqrt(token1/token0)
  const p = ratio * ratio; // token1 per token0
  if (!Number.isFinite(p) || p <= 0) return 0;
  return isToken0 ? p : 1 / p;
}
