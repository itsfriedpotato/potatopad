"use client";

import { Hourglass, Sprout, TrendingUp } from "lucide-react";
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
import { TokenCardSkeleton } from "@/components/Skeletons";

const TABS = [
  { id: "fresh", label: "Fresh Sprouts", Icon: Sprout },
  { id: "top", label: "Top Market Cap", Icon: TrendingUp },
  { id: "ancient", label: "Ancient", Icon: Hourglass },
] as const;

type TabId = (typeof TABS)[number]["id"];

type Slot0 = readonly [bigint, number, number, number, number, number, boolean];

export default function DiscoverPage() {
  const { weth, chainId, isDeployed } = usePad();
  const { query } = useSearch();
  const [tab, setTab] = useState<TabId>("fresh");
  const isAncientTab = tab === "ancient";

  // PotatoPad launches — span ALL pads (primary + legacy).
  const { creations, isLoading: launchLoading } = useLaunchActivity();
  // Pre-existing Robinhood "ancient" runners (Noxa etc.), served by /api/ancient.
  const { tokens: ancientTokens, isLoading: ancientLoading } = useAncientTokens();

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
      // When the query looks like an address (0x…), also match by contract address.
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
    switch (tab) {
      case "fresh":
        return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "top":
        return [...list].sort((a, b) => b.marketCapEth - a.marketCapEth);
      default:
        return list;
    }
  }, [activeRows, query, tab, isAncientTab]);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  const loading = isAncientTab
    ? ancientLoading && ancientTokens.length === 0
    : launchLoading && creations.length === 0;

  return (
    <div>
      {/* Filter pills, centered, with a centered Plant a Coin call to action below */}
      <div className="mb-5 flex flex-wrap items-center justify-center gap-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === id
                ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
                : "border-neutral-800 bg-neutral-900/50 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
            }`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="mb-7 flex justify-center">
        <Link href="/create" className="btn-primary px-5">
          <Sprout className="h-4 w-4" />
          Plant a Coin
        </Link>
      </div>

      {isAncientTab && (
        <div className="mx-auto mb-5 max-w-xl rounded-xl border border-amber-600/20 bg-amber-500/5 px-4 py-3 text-center text-xs text-neutral-400">
          <p className="font-semibold text-amber-500">
            <Hourglass className="mr-1 inline h-3.5 w-3.5" aria-hidden />
            What&apos;s an Ancient? 🏛️
          </p>
          <p className="mt-1">
            A token that launched on <span className="text-neutral-200">Noxa</span> and ran with a
            community — a pre-existing Robinhood runner. We honor the originals here: view and trade
            them, but they can&apos;t be planted on PotatoPad.
          </p>
        </div>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <TokenCardSkeleton key={i} />
          ))}
        </div>
      ) : activeRows.length === 0 ? (
        <div className="card mx-auto max-w-lg p-10 text-center">
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
                Be the first to plant a coin. It launches straight onto Uniswap V3, live from
                the first block.
              </p>
              <Link href="/create" className="btn-primary mt-5">
                Plant the first coin
              </Link>
            </>
          )}
        </div>
      ) : visible.length === 0 ? (
        <div className="card mx-auto max-w-lg p-10 text-center">
          <h2 className="text-lg font-bold text-neutral-100">No coins match</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {query.trim()
              ? `Nothing matches “${query.trim()}” in this patch of the field.`
              : "Nothing in this patch of the field yet."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((row) => (
            <TokenCard key={row.address} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
