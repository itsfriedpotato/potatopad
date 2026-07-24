"use client";

// Data layer: price, market cap and liquidity for a launched token. HYBRID by
// Uniswap version — legacy tokens live on a V3 pool CONTRACT (read slot0 directly),
// new tokens live in the V4 singleton (read the periphery StateView by poolId).
// The chain's `uniswapVersion` (config) routes every read and trade, so existing
// V3 tokens keep displaying and trading unchanged.

import { useMemo } from "react";
import type { Address, Hex } from "viem";
import { useQuery } from "@tanstack/react-query";
import { useChainId, usePublicClient, useReadContract, useReadContracts } from "wagmi";
import { potatoCurvePadAbi, potatoPadAbi } from "@/lib/abi";
import {
  CURVE_PAD_ADDRESSES,
  STATE_VIEW_ADDRESSES,
  UNISWAP_VERSION,
  ZERO_ADDRESS,
} from "@/lib/config";
import { usePad } from "@/lib/hooks";
import { poolIdFor, priceWethPerToken, stateViewAbi, tokenIsToken0 } from "@/lib/v4";

/** Fixed launch supply: 1 billion whole tokens (18 decimals). */
export const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

// Re-exported so existing importers keep one source for the price helpers + poolId.
export { priceWethPerToken, tokenIsToken0, poolIdFor } from "@/lib/v4";

const ZERO_POOL_ID = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;

// ---------------------------------------------------------------------------
// V3 ABIs (legacy tokens) — kept so existing V3 pools keep working
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
  { inputs: [], name: "liquidity", outputs: [{ internalType: "uint128", name: "", type: "uint128" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "token0", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "token1", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "fee", outputs: [{ internalType: "uint24", name: "", type: "uint24" }], stateMutability: "view", type: "function" },
] as const;

/** Uniswap V3 pool `Swap` event — watched to detect live buys on legacy pools. */
export const uniswapV3SwapEventAbi = [
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "sender", type: "address" },
      { indexed: true, internalType: "address", name: "recipient", type: "address" },
      { indexed: false, internalType: "int256", name: "amount0", type: "int256" },
      { indexed: false, internalType: "int256", name: "amount1", type: "int256" },
      { indexed: false, internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { indexed: false, internalType: "uint128", name: "liquidity", type: "uint128" },
      { indexed: false, internalType: "int24", name: "tick", type: "int24" },
    ],
    name: "Swap",
    type: "event",
  },
] as const;

/** Minimal ERC-20 (balanceOf) — used to read a V3 pool's WETH balance as TVL. */
export const erc20BalanceAbi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** SwapRouter02 exactInputSingle + multicall(deadline) + unwrapWETH9 (V3 trading). */
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

/** SwapRouter02 sentinel recipient: "keep output in the router" (for unwrapWETH9). */
export const ROUTER_ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const;

/** QuoterV2 quoteExactInputSingle (V3). `view` so wagmi read hooks accept it. */
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
// Pool stats — HYBRID (V3 pool contract OR V4 StateView by poolId)
// ---------------------------------------------------------------------------

export interface PoolStats {
  sqrtPriceX96: bigint | undefined;
  priceWeth: number;
  marketCapEth: number;
  liquidity: bigint | undefined;
  /** WETH held by the pool — a V3-only TVL proxy (V4's singleton pools all reserves). */
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
 * Live pool stats for a launched token, routed by the chain's Uniswap version.
 * V3: reads the pool contract's slot0 + liquidity + WETH balance. V4: reads the
 * StateView's getSlot0 + getLiquidity by poolId. `pool` is the V3 pool address
 * (ignored on V4); `poolId` is the V4 pool id (ignored on V3). Degrades to zeros
 * when the relevant identifier / address is missing or a read fails.
 */
export function usePoolStats(
  token: Address | undefined,
  pool: Address | undefined,
  poolId?: Hex | undefined,
  /** The pool's quote currency (defaults to WETH). Custom-quote tokens price
   *  against this, so the token0/token1 inversion is measured against it. */
  quote?: Address,
): PoolStats {
  const { weth, chainId } = usePad();
  const pair = quote ?? weth;
  const isV4 = UNISWAP_VERSION[chainId] === "v4";
  const stateView = STATE_VIEW_ADDRESSES[chainId];

  const v3Enabled =
    !isV4 && !!pool && pool !== ZERO_ADDRESS && !!token;
  const v4Enabled =
    isV4 && !!stateView && !!poolId && poolId !== ZERO_POOL_ID && !!token;

  const { data, isLoading, isError } = useReadContracts({
    allowFailure: true,
    contracts: isV4
      ? [
          { address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId ?? ZERO_POOL_ID] },
          { address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId ?? ZERO_POOL_ID] },
        ]
      : [
          { address: pool, abi: uniswapV3PoolAbi, functionName: "slot0" },
          { address: pool, abi: uniswapV3PoolAbi, functionName: "liquidity" },
          { address: weth, abi: erc20BalanceAbi, functionName: "balanceOf", args: [pool ?? weth] },
        ],
    query: { enabled: v3Enabled || v4Enabled },
  });

  return useMemo<PoolStats>(() => {
    const enabled = v3Enabled || v4Enabled;
    if (!enabled) return ZERO_STATS;
    if (isLoading) return { ...ZERO_STATS, isLoading: true, unavailable: false };
    if (!data) return ZERO_STATS;

    // slot0 is a 4-tuple on V4 (StateView) and a 7-tuple on V3; sqrtPriceX96 is
    // element 0 either way, and liquidity is the second read.
    const slot0 = data[0]?.result as readonly [bigint, ...unknown[]] | undefined;
    const liquidity = data[1]?.result as bigint | undefined;
    const wethInPool = isV4 ? undefined : (data[2]?.result as bigint | undefined);
    const sqrtPriceX96 = slot0?.[0];

    if (sqrtPriceX96 === undefined || sqrtPriceX96 === 0n) {
      return { ...ZERO_STATS, liquidity, wethInPool, unavailable: isError || !slot0 };
    }

    const isToken0 = token ? tokenIsToken0(token, pair) : true;
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
  }, [v3Enabled, v4Enabled, isV4, isLoading, isError, data, token, pair]);
}

// ---------------------------------------------------------------------------
// FDV range (open → top), read once from the pad, for progress framing
// ---------------------------------------------------------------------------

export interface FdvRange {
  openFdvEth: number;
  topFdvEth: number;
}

const WEI = 1e18;

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
  isCurve: boolean;
  bonded: boolean;
  bondable: boolean;
  /** V3 pool address (legacy curve pads); ZERO on V4 chains. */
  pool: Address;
  /** V4 pool id (V4 curve pads); ZERO on V3 chains. */
  poolId: Hex;
  creator: Address;
  positionId: bigint;
  progressBps: bigint;
  isLoading: boolean;
  unavailable: boolean;
}

const ZERO_CURVE_STATS: CurveStats = {
  isCurve: false,
  bonded: false,
  bondable: false,
  pool: ZERO_ADDRESS,
  poolId: ZERO_POOL_ID,
  creator: ZERO_ADDRESS,
  positionId: 0n,
  progressBps: 0n,
  isLoading: false,
  unavailable: true,
};

/**
 * Curve metadata for a token: reads curves()/curveProgressBps()/bondable() off
 * the chain's curve pad. On a V3 chain `curves()` returns an `address pool`; on a
 * V4 chain it returns a `bytes32 poolId`. Both are surfaced so the token page
 * prices from the right one.
 */
export function useCurveStats(token: Address | undefined): CurveStats {
  const chainId = useChainId();
  const curvePad = CURVE_PAD_ADDRESSES[chainId] ?? ZERO_ADDRESS;
  const isV4 = UNISWAP_VERSION[chainId] === "v4";
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

    // curves() => (creator, pool|poolId, positionId, bonded)
    const c = data[0]?.result as readonly [Address, Address | Hex, bigint, boolean] | undefined;
    const progress = data[1]?.result as bigint | undefined;
    const bondable = data[2]?.result as boolean | undefined;

    if (!c || !c[0] || c[0] === ZERO_ADDRESS) return ZERO_CURVE_STATS;

    return {
      isCurve: true,
      bonded: c[3],
      bondable: bondable ?? false,
      pool: isV4 ? ZERO_ADDRESS : (c[1] as Address),
      poolId: isV4 ? (c[1] as Hex) : ZERO_POOL_ID,
      creator: c[0],
      positionId: c[2],
      progressBps: progress ?? 0n,
      isLoading: false,
      unavailable: false,
    };
  }, [enabled, isV4, isLoading, data]);
}

// ---------------------------------------------------------------------------
// Accrued (uncollected) LP fees — V3 via NPM.collect simulate; V4 not yet wired
// ---------------------------------------------------------------------------

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
  wethAmount: bigint | undefined;
  tokenAmount: bigint | undefined;
  isLoading: boolean;
  unavailable: boolean;
}

/**
 * Accrued (uncollected) LP fees for the locked position. V3 legacy tokens: reads
 * the locker + NPM from the pad and static-calls NPM.collect with the locker
 * impersonated (the classic poke-and-read trick). V4 tokens: the singleton has no
 * NPM.collect to simulate, so this returns `unavailable` — the fee estimate is a
 * secondary display; harvesting still works via the locker's collect button.
 */
export function useAccruedFees(
  lpTokenId: bigint | undefined,
  pool: Address | undefined,
  pad: Address | undefined,
): AccruedFees {
  const { weth, chainId } = usePad();
  const client = usePublicClient();
  const isV4 = UNISWAP_VERSION[chainId] === "v4";

  const padReady = !isV4 && !!pad && pad !== ZERO_ADDRESS;
  const { data: lockerData } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "locker",
    query: { enabled: padReady },
  });
  const { data: npmData } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    // Legacy V3 pads expose positionManager(); this read is disabled on V4 chains.
    functionName: "positionManager" as "locker",
    query: { enabled: padReady },
  });
  const { data: token0Data } = useReadContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "token0",
    query: { enabled: !isV4 && !!pool && pool !== ZERO_ADDRESS },
  });

  const locker = lockerData as Address | undefined;
  const npm = npmData as Address | undefined;
  const token0 = token0Data as Address | undefined;

  const enabled =
    !isV4 &&
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
          args: [{ tokenId: lpTokenId, recipient: locker, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
          account: locker,
        });
        return result as readonly [bigint, bigint];
      } catch {
        return null;
      }
    },
  });

  return useMemo<AccruedFees>(() => {
    if (isV4) return { wethAmount: undefined, tokenAmount: undefined, isLoading: false, unavailable: true };
    const raw = query.data;
    const wethIsToken0 =
      token0 !== undefined && weth !== ZERO_ADDRESS ? token0.toLowerCase() === weth.toLowerCase() : undefined;

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
  }, [isV4, query.data, query.isLoading, enabled, token0, weth]);
}
