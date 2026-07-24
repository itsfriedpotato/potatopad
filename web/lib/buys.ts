"use client";

// Live buy detection for the Discover "Recent buys" sort. The Discover feed is
// chain-pinned (Robinhood / Uniswap V3), so this watches the V3 pool `Swap` event
// across every token pool via ONE filter (viem accepts an address array), at
// constant RPC cost. A buy bumps its token to the front of the grid; sells are
// ignored by design. (V4 token pages get their own live updates via useTokenPad /
// usePoolStats; the singleton `Swap` event is only needed for a V4-chain feed.)

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { useWatchContractEvent } from "wagmi";
import { WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { tokenIsToken0, uniswapV3SwapEventAbi } from "@/lib/pool";
import { ANALYTICS_CHAIN_ID } from "@/lib/robinhoodPublicClient";

/** Robinhood-pinned pricing WETH (same basis as the rest of the Discover feed). */
const RH_WETH = WETH_ADDRESSES[ANALYTICS_CHAIN_ID] ?? ZERO_ADDRESS;

/** Faster than the global 30s wagmi poll so a buy feels live. */
const BUYS_POLL_MS = 10_000;

export interface BuyTick {
  /** unix ms when the buy was observed locally */
  at: number;
  /** WETH spent, in whole ETH (float) */
  weth: number;
}

export interface TokenPoolPair {
  token: Address;
  pool: Address;
}

/**
 * Watches Uniswap V3 `Swap` on every given pool via ONE event filter and keeps a
 * map of token (lowercase) → latest buy. `onBuys` fires once per poll batch that
 * contained at least one buy (e.g. to refresh pool prices).
 */
export function useRecentBuys(pairs: TokenPoolPair[], onBuys?: () => void) {
  const [buys, setBuys] = useState<Record<string, BuyTick>>({});

  const poolToToken = useMemo(() => {
    const map = new Map<string, Address>();
    for (const { token, pool } of pairs) {
      if (pool !== ZERO_ADDRESS) map.set(pool.toLowerCase(), token);
    }
    return map;
  }, [pairs]);
  const poolsKey = useMemo(() => [...poolToToken.keys()].sort().join(","), [poolToToken]);
  const pools = useMemo(() => (poolsKey ? (poolsKey.split(",") as Address[]) : []), [poolsKey]);

  const mapRef = useRef(poolToToken);
  const onBuysRef = useRef(onBuys);
  useEffect(() => {
    mapRef.current = poolToToken;
    onBuysRef.current = onBuys;
  });

  useWatchContractEvent({
    address: pools,
    abi: uniswapV3SwapEventAbi,
    eventName: "Swap",
    chainId: ANALYTICS_CHAIN_ID,
    enabled: pools.length > 0,
    pollingInterval: BUYS_POLL_MS,
    onLogs: (logs) => {
      const now = Date.now();
      const fresh: Record<string, BuyTick> = {};
      for (const log of logs) {
        const token = mapRef.current.get(log.address.toLowerCase());
        if (!token) continue;
        const args = log.args as { amount0?: bigint; amount1?: bigint };
        // A buy sends WETH INTO the pool: the WETH-side amount is positive (V3's
        // pool-perspective sign).
        const wethIn = tokenIsToken0(token, RH_WETH) ? (args.amount1 ?? 0n) : (args.amount0 ?? 0n);
        if (wethIn <= 0n) continue;
        fresh[token.toLowerCase()] = { at: now, weth: Number(wethIn) / 1e18 };
      }
      if (Object.keys(fresh).length === 0) return;
      setBuys((prev) => ({ ...prev, ...fresh }));
      onBuysRef.current?.();
    },
  });

  const lastBuyAt = useCallback((token: Address) => buys[token.toLowerCase()]?.at, [buys]);

  return { buys, lastBuyAt };
}
