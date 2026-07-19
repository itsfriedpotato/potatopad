"use client";

import { Hourglass, Search, Sprout } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useReadContracts } from "wagmi";
import { ZERO_ADDRESS } from "@/lib/config";
import { useAncientTokens } from "@/lib/ancient";
import { useLaunchActivity } from "@/lib/events";
import { usePad } from "@/lib/hooks";
import {
  priceWethPerToken,
  tokenIsToken0,
  uniswapV3PoolAbi,
  TOTAL_SUPPLY_WHOLE,
} from "@/lib/pool";
import { NotDeployed } from "@/components/NotDeployed";
import { useSearch } from "@/components/SearchContext";
import { TokenCard, type TokenRow } from "@/components/TokenCard";

type TabId = "growing" | "ancient";
type SortId = "recent" | "new" | "old" | "mcap";

const TABS: { id: TabId; label: string }[] = [
  { id: "growing", label: "Growing" },
  { id: "ancient", label: "Ancients" },
];
const SORTS: { id: SortId; label: string }[] = [
  { id: "recent", label: "Recent buys" },
  { id: "new", label: "Newest" },
  { id: "old", label: "Oldest" },
  { id: "mcap", label: "Market Cap" },
];

type Slot0 = readonly [bigint, number, number, number, number, number, boolean];

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900">
      <div className="skeleton aspect-square w-full rounded-none" />
      <div className="space-y-2 p-3">
        <div className="skeleton h-3 w-2/3" />
        <div className="skeleton h-3 w-1/2" />
      </div>
    </div>
  );
}

export default function DiscoverPage() {
  const { weth, chainId, isDeployed } = usePad();
  const { query, setQuery } = useSearch();
  const [tab, setTab] = useState<TabId>("growing");
  const [sort, setSort] = useState<SortId>("recent");
  const isAncientTab = tab === "ancient";

  // PotatoPad launches — span ALL pads (primary + legacy).
  const { creations, unavailable: launchUnavailable, isLoading: launchLoading } =
    useLaunchActivity();
  // Pre-existing Robinhood "ancient" runners (Noxa etc.), served by /api/ancient.
  const {
    tokens: ancientTokens,
    unavailable: ancientUnavailable,
    isLoading: ancientLoading,
  } = useAncientTokens();

  // Price each PotatoPad token from its pool's slot0, index-aligned to `creations`.
  const poolContracts = useMemo(
    () =>
      creations.map((c) => ({
        address: c.pool ?? ZERO_ADDRESS,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
      })),
    [creations],
  );

  const { data: poolReads } = useReadContracts({
    contracts: poolContracts as never[],
    allowFailure: true,
    query: {
      enabled: isDeployed && creations.some((c) => !!c.pool && c.pool !== ZERO_ADDRESS),
      // These ~39 pool reads multiply per visitor. Hold them 60s and don't refetch on
      // every window focus, to cut proxy/RPC load.
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  });

  const padRows = useMemo<TokenRow[]>(
    () =>
      creations.map((c, i) => {
        const slot0 = poolReads?.[i]?.result as Slot0 | undefined;
        const sqrtPriceX96 = slot0?.[0];
        const priceWeth =
          sqrtPriceX96 !== undefined
            ? priceWethPerToken(sqrtPriceX96, tokenIsToken0(c.token, weth))
            : 0;
        return {
          address: c.token,
          name: c.name,
          symbol: c.symbol,
          creator: c.creator,
          pool: c.pool,
          priceWeth,
          marketCapEth: priceWeth * TOTAL_SUPPLY_WHOLE,
          createdAt: c.timestamp,
          imageURI: c.imageURI,
          volume24Usd: c.volume24Usd,
        };
      }),
    [creations, poolReads, weth],
  );

  const ancientRows = useMemo<TokenRow[]>(
    () =>
      ancientTokens.map((t) => ({
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        creator: ZERO_ADDRESS,
        pool: t.tradePool,
        priceWeth: 0,
        marketCapEth: 0,
        imageURI: t.imageUrl,
        ancient: true,
        marketCapUsd: t.fdvUsd,
        volume24Usd: t.volume24Usd,
      })),
    [ancientTokens],
  );

  const activeRows = isAncientTab ? ancientRows : padRows;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = activeRows;
    if (q) {
      const isAddressQuery = q.startsWith("0x");
      list = list.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.symbol.toLowerCase().includes(q) ||
          (isAddressQuery && r.address.toLowerCase().startsWith(q)),
      );
    }
    if (isAncientTab) {
      return [...list].sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
    }
    switch (sort) {
      case "recent":
        return [...list].sort((a, b) => (b.volume24Usd ?? 0) - (a.volume24Usd ?? 0));
      case "new":
        return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "old":
        return [...list].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      case "mcap":
        return [...list].sort((a, b) => b.marketCapEth - a.marketCapEth);
      default:
        return list;
    }
  }, [activeRows, query, sort, isAncientTab]);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  // Treat a soft-degraded scan (unavailable) as "still loading", not "empty", so a
  // transient RPC / cold-cache blip never flashes the empty state.
  const loading = isAncientTab
    ? (ancientLoading || ancientUnavailable) && ancientTokens.length === 0
    : (launchLoading || launchUnavailable) && creations.length === 0;

  const segBase = "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors";

  return (
    <div className="space-y-5">
      {/* Unified header + controls */}
      <div className="flex flex-col gap-4 rounded-2xl border border-neutral-800/60 bg-neutral-950 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-neutral-100">
            {isAncientTab ? "Ancient Heritage" : "Explore Sprouts"}
          </h1>
          {isAncientTab && (
            <p className="mt-1 text-xs text-neutral-500">
              Verified legacy runners from Noxa. Honored here, protected from copycats.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start sm:self-center">
          <div className="flex gap-1 rounded-xl border border-neutral-800 bg-neutral-900 p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`${segBase} ${
                  tab === t.id
                    ? "bg-amber-500 text-neutral-950"
                    : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {!isAncientTab && (
            <div className="flex gap-1 rounded-xl border border-neutral-800 bg-neutral-900 p-1 font-mono">
              {SORTS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSort(s.id)}
                  className={`rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
                    sort === s.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:text-neutral-300"
                  }`}
                >
                  {s.id === "recent" && (
                    <span className="mr-1 inline-block h-1 w-1 rounded-full bg-[#CCFF00] align-middle shadow-[0_0_6px_#CCFF00] animate-pulse" />
                  )}
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Mobile search — the header search bar is desktop-only (md:block). */}
      <div className="relative md:hidden">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
        <input
          type="search"
          aria-label="Search coins by name or symbol"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search coins…"
          className="w-full rounded-xl border border-neutral-800 bg-neutral-950 py-2.5 pl-9 pr-3 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-amber-500/60"
        />
      </div>

      {/* Container panel: amber accent for Growing, stone-gray for Ancients */}
      <div
        className={`rounded-2xl border bg-neutral-950 p-5 sm:p-6 ${
          isAncientTab
            ? "border-neutral-700/40 shadow-[0_0_60px_-30px_rgba(255,255,255,0.08),inset_0_1px_0_rgba(255,255,255,0.03)]"
            : "border-amber-500/25 shadow-[0_0_70px_-28px_rgba(245,158,11,0.35),inset_0_1px_0_rgba(255,255,255,0.04)]"
        }`}
      >
        {loading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : activeRows.length === 0 ? (
          <div className="mx-auto max-w-lg px-6 py-12 text-center">
            {isAncientTab ? (
              <>
                <Hourglass className="mx-auto h-10 w-10 text-amber-600/70" aria-hidden />
                <h2 className="mt-4 text-lg font-bold text-neutral-100">No ancient tokens yet</h2>
                <p className="mt-2 text-sm text-neutral-400">
                  Couldn&apos;t load the pre-existing Robinhood runners right now. Try again in a
                  moment.
                </p>
              </>
            ) : (
              <>
                <Sprout className="mx-auto h-10 w-10 text-green-500/70" aria-hidden />
                <h2 className="mt-4 text-lg font-bold text-neutral-100">Nothing planted yet</h2>
                <p className="mt-2 text-sm text-neutral-400">
                  Be the first to plant a coin. It launches straight onto Uniswap V3, live from the
                  first block.
                </p>
                <Link href="/create" className="btn-primary mt-5">
                  Plant the first coin
                </Link>
              </>
            )}
          </div>
        ) : visible.length === 0 ? (
          <div className="mx-auto max-w-lg px-6 py-12 text-center">
            <h2 className="text-lg font-bold text-neutral-100">No coins match</h2>
            <p className="mt-2 text-sm text-neutral-400">
              {query.trim()
                ? `Nothing matches “${query.trim()}” in this patch of the field.`
                : "Nothing in this patch of the field yet."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {visible.map((row) => (
              <TokenCard key={row.address} row={row} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
