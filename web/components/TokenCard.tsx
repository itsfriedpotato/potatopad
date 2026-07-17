"use client";

import { Hourglass } from "lucide-react";
import Link from "next/link";
import type { Address } from "viem";
import { formatUsd, formatUsdPrice, shortAddress, timeAgo } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
import { fdvProgressBps, useFdvRange } from "@/lib/pool";
import { TokenAvatar } from "@/components/TokenAvatar";

export interface TokenRow {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  pool: Address;
  /** WETH per whole token (float) from the pool */
  priceWeth: number;
  /** fully-diluted valuation in ETH (float) */
  marketCapEth: number;
  /** TokenCreated block timestamp (unix seconds); undefined if history unavailable */
  createdAt?: number;
  /** launch image URL / ipfs hash from TokenCreated (optional) */
  imageURI?: string;
  /** Ancient (pre-existing Robinhood) token — renders USD stats + an Ancient badge. */
  ancient?: boolean;
  /** Ancient market cap (USD) from GeckoTerminal. */
  marketCapUsd?: number;
  /** Ancient 24h volume (USD) from GeckoTerminal. */
  volume24Usd?: number;
}

export function TokenCard({ row }: { row: TokenRow }) {
  const { usd: ethUsd } = useEthUsdPrice();
  const range = useFdvRange();

  if (row.ancient) {
    return (
      <Link
        href={`/token/${row.address}`}
        className="card block p-5 transition-colors hover:border-amber-600/50"
      >
        <div className="flex items-center gap-3">
          <TokenAvatar address={row.address} symbol={row.symbol} size="md" />
          <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <h3 className="truncate font-bold text-neutral-100">{row.name || row.symbol}</h3>
            <span className="shrink-0 font-mono text-xs text-neutral-500">${row.symbol}</span>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-700/40 bg-amber-900/25 px-2 py-0.5 text-[11px] font-semibold text-amber-500/90">
            <Hourglass className="h-3 w-3" aria-hidden />
            Ancient
          </span>
        </div>

        <p className="mt-2.5 truncate text-xs text-neutral-500">
          Pre-existing Robinhood token
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Market Cap
            </p>
            <p className="mt-0.5 font-mono text-sm text-neutral-100">
              {row.marketCapUsd && row.marketCapUsd > 0 ? formatUsd(row.marketCapUsd) : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              24h Volume
            </p>
            <p className="mt-0.5 font-mono text-sm text-neutral-100">
              {row.volume24Usd && row.volume24Usd > 0 ? formatUsd(row.volume24Usd) : "—"}
            </p>
          </div>
        </div>
      </Link>
    );
  }

  const mcapEthLabel = `${row.marketCapEth.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETH`;
  const mcapLabel =
    ethUsd !== null && row.marketCapEth > 0 ? formatUsd(row.marketCapEth * ethUsd) : mcapEthLabel;

  // Range climb: how far price has walked from the open (~3 ETH FDV) toward the
  // top (~525 ETH FDV). NOT a bonding curve — the token is live from block one.
  const progress = Math.max(0, Math.min(100, Number(fdvProgressBps(row.marketCapEth, range)) / 100));
  const stage =
    progress < 12
      ? { label: "Seed", emoji: "🥔", cls: "border-amber-700/40 bg-amber-900/25 text-amber-500/90" }
      : progress < 90
        ? { label: "Growing", emoji: "🌱", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" }
        : { label: "Harvested", emoji: "🌻", cls: "border-amber-500/40 bg-amber-500/15 text-amber-300" };

  return (
    <Link
      href={`/token/${row.address}`}
      className="card block p-5 transition-colors hover:border-amber-500/40"
    >
      <div className="flex items-center gap-3">
        {/* Thumbnail: resolves ipfs:// via public gateways; broken URLs fall back to a potato tile */}
        <TokenAvatar
          address={row.address}
          symbol={row.symbol}
          imageURI={row.imageURI}
          size="md"
        />
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <h3 className="truncate font-bold text-neutral-100">{row.name}</h3>
          <span className="shrink-0 font-mono text-xs text-neutral-500">${row.symbol}</span>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stage.cls}`}
        >
          <span aria-hidden>{stage.emoji}</span>
          {stage.label}
        </span>
      </div>

      <p className="mt-2.5 flex items-center gap-1.5 truncate text-xs text-neutral-500">
        by <span className="font-mono text-neutral-400">{shortAddress(row.creator)}</span>
        {row.createdAt !== undefined && row.createdAt > 0 && (
          <>
            <span aria-hidden>&middot;</span>
            <span className="whitespace-nowrap">{timeAgo(row.createdAt)}</span>
          </>
        )}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Price
          </p>
          <p className="mt-0.5 font-mono text-sm text-neutral-100">
            {ethUsd !== null && row.priceWeth > 0 ? formatUsdPrice(row.priceWeth * ethUsd) : "—"}
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Market Cap
          </p>
          <p className="mt-0.5 font-mono text-sm tabular-nums text-neutral-100">{mcapLabel}</p>
        </div>
      </div>

      {/* Range climb (open → top FDV): Seed → Sprout → Bloom. Not a bonding curve. */}
      <div className="mt-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-amber-500"
            style={{ width: `${Math.max(2, progress)}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-neutral-600">
          <span>🥔 Seed</span>
          <span>{progress.toFixed(0)}% up range</span>
          <span>🌻 Harvest</span>
        </div>
      </div>
    </Link>
  );
}
