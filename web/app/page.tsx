"use client";

import { Sprout, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { potatoPadAbi, potatoTokenAbi } from "@/lib/abi";
import { ZERO_ADDRESS } from "@/lib/config";
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
] as const;

type TabId = (typeof TABS)[number]["id"];

type Slot0 = readonly [bigint, number, number, number, number, number, boolean];
type TokenInfo = readonly [Address, Address, bigint];

export default function DiscoverPage() {
  const { pad, weth, chainId, isDeployed } = usePad();
  const { query } = useSearch();
  const [tab, setTab] = useState<TabId>("fresh");
  const { creationByToken } = useLaunchActivity();

  const { data: tokens } = useReadContract({
    address: pad,
    abi: potatoPadAbi,
    functionName: "getTokens",
    args: [0n, 100n],
    query: { enabled: isDeployed },
  });

  // Stage 1: name, symbol and on-chain info (creator/pool/lpTokenId) per token.
  const metaContracts = useMemo(
    () =>
      (tokens ?? []).flatMap((token) => [
        { address: token, abi: potatoTokenAbi, functionName: "name" },
        { address: token, abi: potatoTokenAbi, functionName: "symbol" },
        { address: pad, abi: potatoPadAbi, functionName: "tokens", args: [token] },
      ]),
    [tokens, pad],
  );

  const { data: metaReads, isLoading: metaLoading } = useReadContracts({
    contracts: metaContracts as never[],
    allowFailure: true,
    query: { enabled: isDeployed && (tokens?.length ?? 0) > 0 },
  });

  // Stage 2: each token's pool price (slot0), keyed to the same token order.
  const pools = useMemo<(Address | undefined)[]>(() => {
    if (!tokens || !metaReads) return [];
    return tokens.map((_, i) => {
      const info = metaReads[i * 3 + 2]?.result as TokenInfo | undefined;
      return info?.[1];
    });
  }, [tokens, metaReads]);

  const poolContracts = useMemo(
    () =>
      pools.map((pool) => ({
        address: pool ?? ZERO_ADDRESS,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
      })),
    [pools],
  );

  const { data: poolReads } = useReadContracts({
    contracts: poolContracts as never[],
    allowFailure: true,
    query: { enabled: isDeployed && pools.some(Boolean) },
  });

  const rows = useMemo<TokenRow[]>(() => {
    if (!tokens || !metaReads) return [];
    const out: TokenRow[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const base = i * 3;
      const name = metaReads[base]?.result as string | undefined;
      const symbol = metaReads[base + 1]?.result as string | undefined;
      const info = metaReads[base + 2]?.result as TokenInfo | undefined;
      if (name === undefined || symbol === undefined || !info) continue;

      const pool = info[1];
      const slot0 = poolReads?.[i]?.result as Slot0 | undefined;
      const sqrtPriceX96 = slot0?.[0];
      const priceWeth =
        sqrtPriceX96 !== undefined
          ? priceWethPerToken(sqrtPriceX96, tokenIsToken0(tokens[i], weth))
          : 0;

      const creation = creationByToken.get(tokens[i].toLowerCase());
      out.push({
        address: tokens[i],
        name,
        symbol,
        creator: info[0],
        pool,
        priceWeth,
        marketCapEth: priceWeth * TOTAL_SUPPLY_WHOLE,
        createdAt: creation?.timestamp,
        imageURI: creation?.imageURI,
      });
    }
    return out;
  }, [tokens, metaReads, poolReads, weth, creationByToken]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter(
        (r) => r.name.toLowerCase().includes(q) || r.symbol.toLowerCase().includes(q),
      );
    }
    switch (tab) {
      case "fresh":
        return [...list].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      case "top":
        return [...list].sort((a, b) => b.marketCapEth - a.marketCapEth);
    }
  }, [rows, query, tab]);

  if (!isDeployed) {
    return <NotDeployed chainId={chainId} />;
  }

  const loading = tokens === undefined || (tokens.length > 0 && (metaLoading || !metaReads));

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

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <TokenCardSkeleton key={i} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card mx-auto max-w-lg p-10 text-center">
          <Sprout className="mx-auto h-10 w-10 text-green-500/70" aria-hidden />
          <h2 className="mt-4 text-lg font-bold text-neutral-100">Nothing planted yet</h2>
          <p className="mt-2 text-sm text-neutral-400">
            Be the first to plant a coin. It launches straight onto Uniswap V3, live from
            the first block.
          </p>
          <Link href="/create" className="btn-primary mt-5">
            Plant the first coin
          </Link>
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
