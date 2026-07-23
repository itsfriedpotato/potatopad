"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * Whether GeckoTerminal has indexed a pool yet. A brand-new pool 404s in GT for
 * its first minutes, and the embed iframe then shows GT's own "page not found"
 * page. Probing the public GT API first lets us show a themed "chart is
 * indexing" placeholder instead, and flip to the real chart once it appears.
 *
 * Fail-open: any non-404 outcome (200, network error, CORS) resolves to
 * "indexed" so existing tokens embed with zero regression; only a definitive
 * 404 yields "missing".
 */
export type GeckoStatus = "indexed" | "missing";

export function useGeckoIndexed(
  network: string | undefined,
  pool: string | undefined,
): GeckoStatus {
  const { data } = useQuery({
    queryKey: ["gecko-indexed", network, pool?.toLowerCase()],
    enabled: !!network && !!pool,
    // Poll while missing so a fresh pool flips to the chart on its own within a
    // minute or two of GT indexing it; stop once found.
    refetchInterval: (q) => (q.state.data === "missing" ? 30_000 : false),
    staleTime: 60_000,
    queryFn: async (): Promise<GeckoStatus> => {
      try {
        const res = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}`,
          { headers: { accept: "application/json" } },
        );
        return res.status === 404 ? "missing" : "indexed";
      } catch {
        return "indexed"; // network/CORS: don't hide a chart that may be fine
      }
    },
  });
  return data ?? "indexed";
}
