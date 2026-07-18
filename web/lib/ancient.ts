"use client";

// "Ancient" tokens: pre-existing Robinhood runners (Noxa etc.) that were not
// launched on PotatoPad. Served pre-built + cached by /api/ancient. Display-only
// on the site (chart + trade), never creatable.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAddress, type Address } from "viem";
import { ZERO_ADDRESS } from "@/lib/config";

export interface AncientToken {
  address: Address;
  name: string;
  symbol: string;
  /** Token logo URL from CoinGecko/GeckoTerminal ("" if none). */
  imageUrl: string;
  /** Deepest WETH pool, for in-app trading (ZERO_ADDRESS if none exists). */
  tradePool: Address;
  /** Fee tier (bps) of `tradePool`, for the swap/quote. */
  feeTier: number;
  fdvUsd: number;
  volume24Usd: number;
  liquidityUsd: number;
  hasWethPool: boolean;
}

interface AncientResponse {
  tokens: Array<
    Omit<AncientToken, "address" | "tradePool"> & { address: string; tradePool: string }
  >;
  unavailable: boolean;
}

const EMPTY: AncientToken[] = [];

function safeAddr(a: string): Address {
  try {
    return getAddress(a);
  } catch {
    return ZERO_ADDRESS;
  }
}

interface AncientResult {
  tokens: AncientToken[];
  unavailable: boolean;
}

export function useAncientTokens() {
  const query = useQuery<AncientResult>({
    queryKey: ["ancient-tokens"],
    staleTime: 120_000,
    gcTime: 30 * 60_000,
    // Poll to auto-recover while the feed is soft-degraded, so a transient blip
    // doesn't strand the gallery on an empty view until the next focus/refresh.
    refetchInterval: (q) => (q.state.data?.unavailable ? 5000 : false),
    queryFn: async () => {
      try {
        const res = await fetch("/api/ancient");
        if (!res.ok) return { tokens: EMPTY, unavailable: true };
        const json = (await res.json()) as AncientResponse;
        const tokens = (json.tokens ?? []).map((t) => ({
          ...t,
          address: safeAddr(t.address),
          tradePool: safeAddr(t.tradePool),
        }));
        return { tokens, unavailable: !!json.unavailable };
      } catch {
        return { tokens: EMPTY, unavailable: true };
      }
    },
  });

  const tokens = query.data?.tokens ?? EMPTY;
  const unavailable = query.data?.unavailable ?? false;
  const byAddress = useMemo(() => {
    const m = new Map<string, AncientToken>();
    for (const t of tokens) m.set(t.address.toLowerCase(), t);
    return m;
  }, [tokens]);

  return { tokens, byAddress, unavailable, isLoading: query.isLoading };
}

/** Look up one token in the ancient list (drives the ancient token-page variant). */
export function useAncientToken(address: Address | undefined): AncientToken | undefined {
  const { byAddress } = useAncientTokens();
  return address ? byAddress.get(address.toLowerCase()) : undefined;
}
