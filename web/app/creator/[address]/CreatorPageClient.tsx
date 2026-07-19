"use client";

import { useQuery } from "@tanstack/react-query";
import { Share2, Sprout } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useAccount } from "wagmi";
import { chainName, WETH_ADDRESSES, ZERO_ADDRESS } from "@/lib/config";
import { useLaunchActivity } from "@/lib/events";
import { shortAddress, shortDate, timeAgo } from "@/lib/format";
import {
  creationsByCreator,
  firstPlantTimestamp,
  latestPlantTimestamp,
  topCoinByMarketCap,
} from "@/lib/padStats";
import { priceWethPerToken, tokenIsToken0, TOTAL_SUPPLY_WHOLE } from "@/lib/pool";
import { ANALYTICS_CHAIN_ID, robinhoodPublicClient } from "@/lib/robinhoodPublicClient";
import { AddressChip } from "@/components/AddressChip";
import { TokenCard, type TokenRow } from "@/components/TokenCard";
import { TokenCardSkeleton } from "@/components/Skeletons";

const PAGE_SIZE = 50;

const SLOT0_ABI = [
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const WETH = WETH_ADDRESSES[ANALYTICS_CHAIN_ID] ?? ZERO_ADDRESS;

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 px-3 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {label}
      </p>
      <p className="mt-1 truncate font-mono text-sm font-bold text-neutral-100">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-neutral-600">{sub}</p>}
    </div>
  );
}

export function CreatorPageClient({ address: raw }: { address: string }) {
  const valid = isAddress(raw);
  const address = valid ? getAddress(raw) : undefined;
  const { address: connected, chainId: walletChain } = useAccount();
  const {
    // Unfiltered: planter identity must include list-hidden coins.
    allCreations,
    isLoading,
    state: feedState,
    scanCompletedAt,
  } = useLaunchActivity();

  const [page, setPage] = useState(0);
  const [shareMsg, setShareMsg] = useState("");

  // Newest first — feed scan order is not chronological; profiles should feel like a timeline.
  const mine = useMemo(() => {
    if (!address) return [];
    return [...creationsByCreator(allCreations, address)].sort(
      (a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0),
    );
  }, [allCreations, address]);

  const pageCount = Math.max(1, Math.ceil(mine.length / PAGE_SIZE));
  // Clamp so navigating between planters (or a shrinking feed) never strands on
  // an empty page past the last valid index.
  const safePage = Math.min(page, pageCount - 1);
  useEffect(() => {
    setPage(0);
  }, [address]);
  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  const pageItems = useMemo(
    () => mine.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [mine, safePage],
  );

  const pricesQuery = useQuery({
    queryKey: [
      "creator-slot0",
      ANALYTICS_CHAIN_ID,
      address,
      safePage,
      pageItems.map((c) => c.token).join(","),
    ],
    enabled: pageItems.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const map = new Map<string, number | null>();
      // Bound concurrency: batches of 8 individual reads (no Multicall3 assumed).
      const CONCURRENCY = 8;
      for (let i = 0; i < pageItems.length; i += CONCURRENCY) {
        const batch = pageItems.slice(i, i + CONCURRENCY);
        await Promise.all(
          batch.map(async (c) => {
            const key = c.token.toLowerCase();
            if (!c.pool || c.pool === ZERO_ADDRESS) {
              map.set(key, null);
              return;
            }
            try {
              const slot0 = await robinhoodPublicClient.readContract({
                address: c.pool as Address,
                abi: SLOT0_ABI,
                functionName: "slot0",
              });
              const sqrt = slot0[0];
              if (sqrt <= 0n) {
                map.set(key, null);
                return;
              }
              const p = priceWethPerToken(sqrt, tokenIsToken0(c.token as Address, WETH));
              map.set(key, Number.isFinite(p) && p > 0 ? p : null);
            } catch {
              map.set(key, null);
            }
          }),
        );
      }
      return map;
    },
  });

  const rows: TokenRow[] = useMemo(
    () =>
      pageItems.map((c) => {
        const price = pricesQuery.data?.get(c.token.toLowerCase()) ?? null;
        return {
          address: c.token as Address,
          name: c.name,
          symbol: c.symbol,
          creator: c.creator as Address,
          pool: c.pool as Address,
          priceWeth: price,
          marketCapEth: price != null ? price * TOTAL_SUPPLY_WHOLE : null,
          createdAt: c.timestamp,
          imageURI: c.imageURI,
        };
      }),
    [pageItems, pricesQuery.data],
  );

  const topCoin = useMemo(() => topCoinByMarketCap(rows), [rows]);

  const isYou =
    !!address && !!connected && connected.toLowerCase() === address.toLowerCase();

  async function shareProfile() {
    if (!address) return;
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      if (navigator.share) {
        await navigator.share({
          title: `Creator ${shortAddress(address)} · PotatoPad`,
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        setShareMsg("Link copied");
        setTimeout(() => setShareMsg(""), 2000);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        setShareMsg("Link copied");
        setTimeout(() => setShareMsg(""), 2000);
      } catch {
        /* ignore */
      }
    }
  }

  if (!valid || !address) {
    return (
      <div className="card mx-auto max-w-lg p-10 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Invalid address</h2>
        <p className="mt-2 text-sm text-neutral-400">That URL is not a valid wallet address.</p>
        <Link href="/" className="btn-secondary mt-5 inline-flex">
          Back to Discover
        </Link>
      </div>
    );
  }

  if (isLoading && allCreations.length === 0 && feedState !== "stale") {
    return (
      <div>
        <div className="card mb-6 h-28 animate-pulse bg-neutral-900/80" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <TokenCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (feedState === "unavailable" && allCreations.length === 0) {
    return (
      <div className="card mx-auto max-w-lg p-10 text-center">
        <h2 className="text-lg font-bold text-neutral-100">Creator activity unavailable</h2>
        <p className="mt-2 text-sm text-neutral-400">
          The launch feed could not be loaded. Try again in a moment.
        </p>
        <Link href="/" className="btn-secondary mt-5 inline-flex">
          Back to Discover
        </Link>
      </div>
    );
  }

  // Planter-scoped: non-planters do not get the full profile chrome.
  // Journey note: right after a plant, the server feed can lag (~TTL). Never tell the
  // connected planter "you never launched" when the feed is empty — that is indexing lag.
  if (mine.length === 0) {
    return (
      <div className="card mx-auto max-w-lg p-10 text-center">
        {isYou ? (
          <>
            <Sprout className="mx-auto h-10 w-10 text-amber-500/80" aria-hidden />
            <h2 className="mt-4 text-lg font-bold text-neutral-100">
              Looking for your plants…
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              New launches can take a minute or two to show up here while the Discover feed
              refreshes. If you just planted, stay on the token page from the success redirect,
              then reopen this profile shortly — or plant your first coin below.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              <Link href="/create" className="btn-primary inline-flex">
                Plant a Coin
              </Link>
              <Link href="/" className="btn-secondary inline-flex">
                Back to Discover
              </Link>
            </div>
          </>
        ) : feedState === "stale" ? (
          <>
            <h2 className="text-lg font-bold text-neutral-100">
              No plants found in the last updated data
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              Cached snapshot may be incomplete — try again later.
            </p>
            {scanCompletedAt > 0 && (
              <p className="mt-2 text-xs text-neutral-600">
                Last updated {new Date(scanCompletedAt).toLocaleString()}
              </p>
            )}
            <Link href="/" className="btn-secondary mt-6 inline-flex">
              Back to Discover
            </Link>
          </>
        ) : (
          <>
            <Sprout className="mx-auto h-10 w-10 text-green-500/70" aria-hidden />
            <h2 className="mt-4 text-lg font-bold text-neutral-100">
              Not a PotatoPad planter
            </h2>
            <p className="mt-2 text-sm text-neutral-400">
              {shortAddress(address)} hasn&apos;t planted a coin on PotatoPad (Robinhood)
              yet. Profiles are for wallets that have launched at least once.
            </p>
            <div className="mt-4 flex justify-center">
              <AddressChip address={address} chainId={ANALYTICS_CHAIN_ID} />
            </div>
            <Link href="/" className="btn-secondary mt-6 inline-flex">
              Back to Discover
            </Link>
          </>
        )}
      </div>
    );
  }

  const first = firstPlantTimestamp(mine);
  const latest = latestPlantTimestamp(mine);

  return (
    <div>
      <div className="card mb-6 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-mono text-xl font-bold text-neutral-100">
                {shortAddress(address)}
              </h1>
              {isYou && (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-400">
                  You
                </span>
              )}
              <span className="rounded-full border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs text-neutral-400">
                {chainName(ANALYTICS_CHAIN_ID)}
              </span>
            </div>
            <div className="mt-3">
              <AddressChip address={address} chainId={ANALYTICS_CHAIN_ID} />
            </div>
          </div>
          <button
            type="button"
            onClick={shareProfile}
            className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Share2 className="h-3.5 w-3.5" />
            Share profile
          </button>
        </div>
        <p className="sr-only" aria-live="polite">
          {shareMsg}
        </p>
        {shareMsg && (
          <p className="mt-2 text-xs text-green-500" aria-hidden>
            {shareMsg}
          </p>
        )}

        {walletChain !== undefined && walletChain !== ANALYTICS_CHAIN_ID && (
          <p className="mt-3 text-xs text-neutral-500">
            Showing Robinhood Chain plants. Switch your wallet to Robinhood to trade.
          </p>
        )}

        {feedState === "stale" && (
          <p className="mt-3 text-xs text-neutral-600">
            Last updated{" "}
            {scanCompletedAt > 0 ? new Date(scanCompletedAt).toLocaleString() : "unknown"}
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Coins planted" value={String(mine.length)} />
          <Stat
            label="First plant"
            value={first != null ? shortDate(first) : "—"}
            sub={first != null ? timeAgo(first) : undefined}
          />
          <Stat
            label="Latest plant"
            value={latest != null ? timeAgo(latest) : "—"}
            sub={latest != null ? shortDate(latest) : undefined}
          />
          <Stat
            label="Top coin"
            value={
              topCoin
                ? `$${topCoin.symbol}${
                    topCoin.marketCapEth != null
                      ? ` · ${topCoin.marketCapEth.toLocaleString("en-US", {
                          maximumFractionDigits: 2,
                        })} ETH`
                      : ""
                  }`
                : "—"
            }
            sub={
              topCoin
                ? pageCount > 1
                  ? "Highest MC on this page only (not all plants)"
                  : "Among priced coins on this list"
                : "Prices fill in as pools respond"
            }
          />
        </div>
        <p className="mt-3 text-[11px] text-neutral-600">
          Launch history only — not volume, holdings, fees, or rank. Sort is newest plant first.
        </p>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-300">
          Coins planted
          {pricesQuery.isFetching && (
            <span className="ml-2 text-xs font-normal text-neutral-600">updating prices…</span>
          )}
        </h2>
        {pageCount > 1 && (
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <button
              type="button"
              disabled={safePage <= 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded border border-neutral-800 px-2 py-1 disabled:opacity-40"
            >
              Prev
            </button>
            <span>
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              className="rounded border border-neutral-800 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rows.map((row) => (
          <TokenCard key={row.address} row={row} hideCreatorLink />
        ))}
      </div>
    </div>
  );
}
