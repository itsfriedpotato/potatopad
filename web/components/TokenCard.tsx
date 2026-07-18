"use client";

import Link from "next/link";
import type { Address } from "viem";
import { formatUsd, shortAddress, timeAgo } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
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

  const mcapUsd = row.ancient
    ? (row.marketCapUsd ?? 0)
    : ethUsd !== null && row.marketCapEth > 0
      ? row.marketCapEth * ethUsd
      : 0;
  const mc = mcapUsd > 0 ? formatUsd(mcapUsd) : "—";

  // ── Ancient card: image, name, MC + 24h VOL, Ancient tag ──
  if (row.ancient) {
    const vol = row.volume24Usd && row.volume24Usd > 0 ? formatUsd(row.volume24Usd) : "—";
    return (
      <Link
        href={`/token/${row.address}`}
        className="group flex flex-col overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900 transition-colors hover:border-amber-500/30"
      >
        <div className="relative">
          <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
          <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400/90 backdrop-blur-md">
            Ancient
          </span>
        </div>
        <div className="flex flex-1 flex-col justify-between gap-2 p-3">
          <div className="flex items-baseline justify-between gap-1.5">
            <h3 className="truncate text-sm font-bold text-neutral-100">{row.name || row.symbol}</h3>
            <span className="shrink-0 font-mono text-[10px] text-neutral-500">${row.symbol}</span>
          </div>
          <div className="flex items-baseline justify-between font-mono text-xs">
            <span className="font-bold text-amber-400">
              {mc} <span className="text-[9px] font-normal text-neutral-500">MC</span>
            </span>
            <span className="text-neutral-400">
              {vol} <span className="text-[9px] font-normal text-neutral-600">VOL</span>
            </span>
          </div>
        </div>
      </Link>
    );
  }

  // ── PotatoPad card: image (age overlay), name, MC ──
  return (
    <Link
      href={`/token/${row.address}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900 transition-colors hover:border-amber-500/40"
    >
      <div className="relative">
        <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
        {row.createdAt !== undefined && row.createdAt > 0 && (
          <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9px] text-neutral-300 backdrop-blur-md">
            {timeAgo(row.createdAt)}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col justify-between gap-2.5 p-3">
        <div>
          <div className="flex items-baseline justify-between gap-1.5">
            <h3 className="truncate text-sm font-bold text-neutral-100">{row.name}</h3>
            <span className="shrink-0 font-mono text-[10px] text-neutral-500">${row.symbol}</span>
          </div>
          <p className="mt-1.5 font-mono text-xs font-bold text-neutral-200">
            {mc} <span className="text-[10px] font-normal text-neutral-500">MC</span>
          </p>
        </div>
        <div className="truncate font-mono text-[9px] text-neutral-600">
          {shortAddress(row.address)}
        </div>
      </div>
    </Link>
  );
}
