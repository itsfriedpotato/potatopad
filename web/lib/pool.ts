"use client";

// v2 data layer: price, market cap and liquidity come from the Uniswap V3 pool
// (not the pad — there is no bonding curve). Everything here reads the pool's
// slot0 / liquidity and the ERC-20 WETH balance held by the pool.

import { useMemo } from "react";
import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useChainId, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { potatoCurvePadAbi, potatoPadAbi } from "@/lib/abi";
import { CURVE_PAD_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { usePad } from "@/lib/hooks";

/** Fixed launch supply: 1 billion whole tokens (18 decimals). */
export const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

// ---------------------------------------------------------------------------
// Inline Uniswap V3 ABIs (only the pieces the frontend touches)
// ---------------------------------------------------------------------------

/** Minimal Uniswap V3 pool: slot0 (price), liquidity, token0/token1, fee. */
export const uniswapV3PoolAbi = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { internalType: "int24", name: "tick", type: "int24" },
      { internalType: "uint16", name: "observationIndex", type: "uint16" },
      { internalType: "uint16", name: "observationCardinality", type: "uint16" },
      { internalType: "uint16", name: "observationCardinalityNext", type: "uint16" },
      { internalType: "uint8", name: "feeProtocol", type: "uint8" },
      { internalType: "bool", name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ internalType: "uint128", name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "fee",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** Minimal ERC-20 (balanceOf) — used to read the pool's WETH balance as TVL. */
export const erc20BalanceAbi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/**
 * SwapRouter02 `exactInputSingle` (no `deadline` in the "02" struct) plus the
 * deadline-checked `multicall(uint256 deadline, bytes[] data)`. Wrapping a single
 * `exactInputSingle` call in `multicall(deadline, [...])` reverts once
 * `block.timestamp > deadline`, so a signed-but-unmined swap can't be held in
 * the mempool and executed later at a sandwich-profitable moment. `multicall` is
 * `payable` and delegatecalls each entry, so native-ETH buys behave identically.
 */
export const swapRouter02Abi = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct IV3SwapRouter.ExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "deadline", type: "uint256" },
      { internalType: "bytes[]", name: "data", type: "bytes[]" },
    ],
    name: "multicall",
    outputs: [{ internalType: "bytes[]", name: "", type: "bytes[]" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" },
    ],
    name: "unwrapWETH9",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

/**
 * SwapRouter02's sentinel recipient meaning "keep the output in the router",
 * so a follow-up call in the same multicall (unwrapWETH9) can pay it out as
 * native ETH.
 */
export const ROUTER_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const;

/**
 * QuoterV2 quoteExactInputSingle. Marked `view` here so wagmi's read hooks
 * accept it — the real contract is `nonpayable` but is designed to be called
 * via `eth_call`, which is exactly what a read does.
 */
export const quoterV2Abi = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint24", name: "fee", type: "uint24" },
          { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        internalType: "struct IQuoterV2.QuoteExactInputSingleParams",
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      { internalType: "uint160", name: "sqrtPriceX96After", type: "uint160" },
      { internalType: "uint32", name: "initializedTicksCrossed", type: "uint32" },
      { internalType: "uint256", name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ---------------------------------------------------------------------------
// Price math
// ---------------------------------------------------------------------------

const Q96 = 2 ** 96;

/** True iff `token` sorts as token0 in a token/WETH pool (token address < weth). */
export function tokenIsToken0(token: Address, weth: Address): boolean {
  return BigInt(token) < BigInt(weth);
}

/**
 * WETH per whole token from a pool sqrtPriceX96. Uniswap's raw price is token1
 * per token0; both assets are 18-decimals, so the wei ratio equals the
 * whole-token ratio. Invert when the launched token is token1.
 */
export function priceWethPerToken(sqrtPriceX96: bigint, isToken0: boolean): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = Number(sqrtPriceX96) / Q96; // sqrt(token1/token0)
  const p = ratio * ratio; // token1 per token0
  if (!Number.isFinite(p) || p <= 0) return 0;
  return isToken0 ? p : 1 / p;
}

export interface PoolStats {
  /** raw pool price */
  sqrtPriceX96: bigint | undefined;
  /** WETH per whole token (float), 0 when unknown */
  priceWeth: number;
  /** fully-diluted valuation in ETH = priceWeth * 1e9 supply */
  marketCapEth: number;
  /** Uniswap concentrated-liquidity L value */
  liquidity: bigint | undefined;
  /** WETH held by the pool — a rough TVL proxy */
  wethInPool: bigint | undefined;
  isLoading: boolean;
  unavailable: boolean;
}

const ZERO_STATS: PoolStats = {
  sqrtPriceX96: undefined,
  priceWeth: 0,
  marketCapEth: 0,
  liquidity: undefined,
  wethInPool: undefined,
  isLoading: false,
  unavailable: true,
};

/**
 * Live pool stats for a launched token. Reads slot0 + liquidity + the pool's
 * WETH balance and derives price + market cap. Degrades to zeros when the pool
 * address is missing or a read fails.
 */
export function usePoolStats(token: Address | undefined, pool: Address | undefined): PoolStats {
  const { weth } = usePad();
  const enabled = !!pool && pool !== "0x0000000000000000000000000000000000000000" && !!token;

  const { data, isLoading, isError } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" },
      { address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" },
      { address: weth, abi: erc20BalanceAbi, functionName: "balanceOf", args: [pool ?? weth] },
    ],
    query: { enabled },
  });

  return useMemo<PoolStats>(() => {
    if (!enabled) return ZERO_STATS;
    if (isLoading) return { ...ZERO_STATS, isLoading: true, unavailable: false };
    if (!data) return ZERO_STATS;

    const slot0 = data[0]?.result as
      | readonly [bigint, number, number, number, number, number, boolean]
      | undefined;
    const liquidity = data[1]?.result as bigint | undefined;
    const wethInPool = data[2]?.result as bigint | undefined;
    const sqrtPriceX96 = slot0?.[0];

    if (sqrtPriceX96 === undefined) {
      return { ...ZERO_STATS, liquidity, wethInPool, unavailable: isError || !slot0 };
    }

    const isToken0 = token ? tokenIsToken0(token, weth) : true;
    const priceWeth = priceWethPerToken(sqrtPriceX96, isToken0);
    return {
      sqrtPriceX96,
      priceWeth,
      marketCapEth: priceWeth * TOTAL_SUPPLY_WHOLE,
      liquidity,
      wethInPool,
      isLoading: false,
      unavailable: false,
    };
  }, [enabled, isLoading, isError, data, token, weth]);
}

// ---------------------------------------------------------------------------
// FDV range (open → top), read once from the pad, for progress framing
// ---------------------------------------------------------------------------

export interface FdvRange {
  /** open / launch FDV in ETH (float) */
  openFdvEth: number;
  /** range-ceiling FDV in ETH (float) */
  topFdvEth: number;
}

const WEI = 1e18;

/** Reads the DIRECT pad's actual open/top FDV (in wei) and returns them as ETH
 *  floats. Only the direct-to-Uniswap pad exposes an FDV range; curve tokens use
 *  {useCurveStats} progress instead. */
export function useFdvRange(): FdvRange {
  const { directPad } = usePad();
  const { data } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: directPad, abi: potatoPadAbi, functionName: "actualStartFdv" },
      { address: directPad, abi: potatoPadAbi, functionName: "actualTopFdv" },
    ],
    query: { enabled: directPad !== ZERO_ADDRESS },
  });
  const openWei = data?.[0]?.result as bigint | undefined;
  const topWei = data?.[1]?.result as bigint | undefined;
  return {
    openFdvEth: openWei !== undefined ? Number(openWei) / WEI : 3,
    topFdvEth: topWei !== undefined ? Number(topWei) / WEI : 530,
  };
}

/** Fraction (0–10000 bps) of the way current FDV sits within [open, top]. */
export function fdvProgressBps(marketCapEth: number, range: FdvRange): bigint {
  const { openFdvEth, topFdvEth } = range;
  if (!(topFdvEth > openFdvEth) || marketCapEth <= 0) return 0n;
  const frac = (marketCapEth - openFdvEth) / (topFdvEth - openFdvEth);
  const clamped = Math.max(0, Math.min(1, frac));
  return BigInt(Math.round(clamped * 10000));
}

// ---------------------------------------------------------------------------
// Curve stats — price / progress for a PRE-graduation bonding-curve token
// ---------------------------------------------------------------------------

export interface CurveStats {
  /** True when the token was launched on the curve pad (creator != 0). */
  isCurve: boolean;
  /** True once the curve bonded (position locked into the fee locker). */
  bonded: boolean;
  /** True once the price crossed the bond tick and `bond()` can be called. */
  bondable: boolean;
  /** The Uniswap pool — non-zero from creation (single-sided-v3 curve). */
  pool: Address;
  creator: Address;
  /** The single-sided position id (the curve AND the LP). */
  positionId: bigint;
  /** Progress toward the bond price, 0..10000 bps. */
  progressBps: bigint;
  isLoading: boolean;
  unavailable: boolean;
}

const ZERO_CURVE_STATS: CurveStats = {
  isCurve: false,
  bonded: false,
  bondable: false,
  pool: ZERO_ADDRESS,
  creator: ZERO_ADDRESS,
  positionId: 0n,
  progressBps: 0n,
  isLoading: false,
  unavailable: true,
};

/**
 * Curve metadata for a token: reads curves()/curveProgressBps() off the chain's
 * curve pad. `isCurve` is false for tokens not on the curve pad (the page then
 * falls through to pool/ancient paths). Price and liquidity are NOT read here —
 * the single-sided-v3 curve has a live Uniswap pool from block one, so both come
 * from {usePoolStats} continuously across migration; this hook only carries the
 * curve-specific state (migration flag + progress) that drives the curve UI.
 */
export function useCurveStats(token: Address | undefined): CurveStats {
  const chainId = useChainId();
  const curvePad = CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const enabled = curvePad !== ZERO_ADDRESS && !!token;

  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: curvePad, abi: potatoCurvePadAbi, functionName: "curves", args: [token ?? ZERO_ADDRESS] },
      { address: curvePad, abi: potatoCurvePadAbi, functionName: "curveProgressBps", args: [token ?? ZERO_ADDRESS] },
      { address: curvePad, abi: potatoCurvePadAbi, functionName: "bondable", args: [token ?? ZERO_ADDRESS] },
    ],
    query: { enabled },
  });

  return useMemo<CurveStats>(() => {
    if (!enabled) return ZERO_CURVE_STATS;
    if (isLoading) return { ...ZERO_CURVE_STATS, isLoading: true, unavailable: false };
    if (!data) return ZERO_CURVE_STATS;

    // curves() => (creator, pool, positionId, bonded)
    const c = data[0]?.result as readonly [Address, Address, bigint, boolean] | undefined;
    const progress = data[1]?.result as bigint | undefined;
    const bondable = data[2]?.result as boolean | undefined;

    if (!c || !c[0] || c[0] === ZERO_ADDRESS) return ZERO_CURVE_STATS;

    return {
      isCurve: true,
      bonded: c[3],
      bondable: bondable ?? false,
      pool: c[1],
      creator: c[0],
      positionId: c[2],
      progressBps: progress ?? 0n,
      isLoading: false,
      unavailable: false,
    };
  }, [enabled, isLoading, data]);
}

// ---------------------------------------------------------------------------
// Accrued (uncollected) LP fees sitting in the locked position
// ---------------------------------------------------------------------------

/**
 * Uniswap V3 NonfungiblePositionManager `collect`. Static-calling this with the
 * position owner impersonated makes the NPM self-poke the position and return
 * the true uncollected fee amounts — the amounts a real `collect` would harvest.
 */
const npmCollectAbi = [
  {
    name: "collect",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

const MAX_UINT128 = 2n ** 128n - 1n;

export interface AccruedFees {
  /** uncollected WETH-side fees (wei); undefined until known/available */
  wethAmount: bigint | undefined;
  /** uncollected launched-token-side fees (wei); undefined until known/available */
  tokenAmount: bigint | undefined;
  isLoading: boolean;
  /** true when the simulate reverted or inputs are missing (degrade gracefully) */
  unavailable: boolean;
}

/**
 * Accrued (uncollected) LP fees for the locked position. Reads the locker (the
 * position owner) and NPM from the pad, then static-calls NPM.collect with the
 * locker impersonated so the position is poked and returns real fee amounts.
 * Maps amount0/amount1 to WETH vs. the launched token via the pool's token0.
 * Refetches ~every 15s and degrades to `unavailable` on any failure.
 */
export function useAccruedFees(
  lpTokenId: bigint | undefined,
  pool: Address | undefined,
  pad: Address | undefined,
): AccruedFees {
  const { weth, chainId } = usePad();
  const client = usePublicClient();

  // Read the locker + NPM from the pad that ACTUALLY launched this token (the
  // token page resolves it and passes it in). A legacy token's LP position is
  // owned by the legacy pad's locker, so using the primary pad's locker here
  // would make the collect-simulate revert and report zero fees.
  const padReady = !!pad && pad !== ZERO_ADDRESS;
  const { data: lockerData } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "locker",
    query: { enabled: padReady },
  });
  const { data: npmData } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "positionManager",
    query: { enabled: padReady },
  });
  const { data: token0Data } = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "token0",
    query: { enabled: !!pool && pool !== ZERO_ADDRESS },
  });

  const locker = lockerData as Address | undefined;
  const npm = npmData as Address | undefined;
  const token0 = token0Data as Address | undefined;

  const enabled =
    !!client &&
    lpTokenId !== undefined &&
    lpTokenId > 0n &&
    !!locker &&
    locker !== ZERO_ADDRESS &&
    !!npm &&
    npm !== ZERO_ADDRESS;

  const query = useQuery<readonly [bigint, bigint] | null>({
    queryKey: ["accrued-fees", chainId, npm, locker, lpTokenId?.toString()],
    enabled,
    staleTime: 15_000,
    refetchInterval: 15_000,
    queryFn: async () => {
      if (!client || !npm || !locker || lpTokenId === undefined) return null;
      try {
        const { result } = await client.simulateContract({
          address: npm,
          abi: npmCollectAbi,
          functionName: "collect",
          args: [
            {
              tokenId: lpTokenId,
              recipient: locker,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
          account: locker, // impersonate the owner so the poke+collect simulates
        });
        return result as readonly [bigint, bigint];
      } catch {
        // Simulate reverted / RPC lacks state-override — degrade gracefully.
        return null;
      }
    },
  });

  return useMemo<AccruedFees>(() => {
    const raw = query.data;
    // token0 == weth -> amount0 is the WETH side; otherwise amount1 is WETH.
    const wethIsToken0 =
      token0 !== undefined && weth !== ZERO_ADDRESS
        ? token0.toLowerCase() === weth.toLowerCase()
        : undefined;

    if (!raw || wethIsToken0 === undefined) {
      return {
        wethAmount: undefined,
        tokenAmount: undefined,
        isLoading: enabled && (query.isLoading || token0 === undefined),
        unavailable: !enabled || query.data === null,
      };
    }

    const [amount0, amount1] = raw;
    return {
      wethAmount: wethIsToken0 ? amount0 : amount1,
      tokenAmount: wethIsToken0 ? amount1 : amount0,
      isLoading: false,
      unavailable: false,
    };
  }, [query.data, query.isLoading, enabled, token0, weth]);
}
