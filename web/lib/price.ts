"use client";

import { useQuery } from "@tanstack/react-query";

export interface EthUsdPrice {
  /** ETH spot price in USD, or null when every source failed. */
  usd: number | null;
  isLoading: boolean;
}

// Relay's public price endpoint: native ETH on mainnet -> { price: 1885.25 }.
// No API key, permissive CORS, and it's the same pricing infra used for swaps.
const RELAY_ETH_USD =
  "https://api.relay.link/currencies/token/price?chainId=1&address=0x0000000000000000000000000000000000000000";

/**
 * Fetch the ETH/USD spot price from a public, no-auth source. Relay is the
 * primary; Coinbase is a fallback. Returns null if both fail (never guesses).
 */
async function fetchEthUsd(): Promise<number | null> {
  // Primary: Relay -> { price: 1885.25 }
  try {
    const res = await fetch(RELAY_ETH_USD);
    if (res.ok) {
      const json = (await res.json()) as { price?: number };
      const price = json?.price;
      if (typeof price === "number" && Number.isFinite(price) && price > 0) {
        return price;
      }
    }
  } catch {
    // fall through to the fallback source
  }

  // Fallback: Coinbase spot price -> { data: { amount: "3456.78" } }
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot");
    if (res.ok) {
      const json = (await res.json()) as { data?: { amount?: string } };
      const amount = Number(json?.data?.amount);
      if (Number.isFinite(amount) && amount > 0) return amount;
    }
  } catch {
    // give up gracefully
  }

  return null;
}

/** Live ETH/USD spot price, cached for ~60s. usd is null when the fetch fails. */
export function useEthUsdPrice(): EthUsdPrice {
  const { data, isLoading } = useQuery({
    queryKey: ["eth-usd"],
    queryFn: fetchEthUsd,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  return { usd: data ?? null, isLoading };
}
