"use client";

import { useQuery } from "@tanstack/react-query";

export interface EthUsdPrice {
  /** ETH spot price in USD, or null when the lookup failed. */
  usd: number | null;
  /**
   * True while the FIRST fetch is still in flight — the price is unknown but may
   * yet arrive. Callers must distinguish this from a null `usd`: rendering both
   * as "—" makes a page that is merely loading look like one whose data is
   * unavailable, which is what made market caps appear to randomly vanish.
   */
  isLoading: boolean;
}

/**
 * Live ETH/USD spot price, via our own `/api/eth-price`.
 *
 * Deliberately NOT fetched from Relay/Coinbase in the browser any more: those
 * are among the most commonly blocked hosts by ad/tracker blockers
 * (`api.coinbase.com` especially), and a blocked fetch blanks the market cap on
 * every PotatoPad card at once, since they all price in ETH. Same-origin also
 * means one cached upstream call shared by all visitors rather than one per tab.
 */
async function fetchEthUsd(): Promise<number | null> {
  try {
    const res = await fetch("/api/eth-price");
    if (!res.ok) return null;
    const json = (await res.json()) as { usd?: number | null };
    const usd = json?.usd;
    return typeof usd === "number" && Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
}

export function useEthUsdPrice(): EthUsdPrice {
  const { data, isPending } = useQuery({
    queryKey: ["eth-usd"],
    queryFn: fetchEthUsd,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  // `isPending`, not `isLoading`: a background refetch of an already-known price
  // must not flip cards back into a loading state.
  return { usd: data ?? null, isLoading: isPending };
}
