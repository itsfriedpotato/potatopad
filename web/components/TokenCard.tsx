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
        className="group flex flex-col overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900 shadow-[0_6px_16px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#CCFF00]/30 hover:shadow-[0_14px_28px_-8px_rgba(0,0,0,0.6),0_0_18px_rgba(204,255,0,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]"
      >
        <div className="relative">
          <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-neutral-900 via-neutral-900/40 to-transparent" />
          <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400/90 backdrop-blur-md">
            Ancient
          </span>
        </div>
        <div className="flex flex-1 flex-col justify-between gap-2 p-3">
          <div className="space-y-0.5">
            <h3 className="truncate text-sm font-bold text-neutral-100">{row.name || row.symbol}</h3>
            <div className="font-mono text-[11px] text-[#CCFF00]/70">${row.symbol}</div>
          </div>
          <div className="space-y-1 font-mono text-xs">
            <p className="font-bold text-neutral-100">
              {mc} <span className="text-[9px] font-normal text-neutral-500">MC</span>
            </p>
            <p className="text-neutral-400">
              {vol} <span className="text-[9px] font-normal text-neutral-600">VOL</span>
            </p>
          </div>
        </div>
      </Link>
    );
  }

  // ── PotatoPad card: image (age overlay), name, MC ──
  return (
    <Link
      href={`/token/${row.address}`}
      className="group flex flex-col overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900 shadow-[0_6px_16px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#CCFF00]/30 hover:shadow-[0_14px_28px_-8px_rgba(0,0,0,0.6),0_0_18px_rgba(204,255,0,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]"
    >
      <div className="relative">
        <TokenAvatar address={row.address} symbol={row.symbol} imageURI={row.imageURI} fill />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-neutral-900 via-neutral-900/40 to-transparent" />
        {row.createdAt !== undefined && row.createdAt > 0 && (
          <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9px] text-neutral-300 backdrop-blur-md">
            {timeAgo(row.createdAt)}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col justify-between gap-2.5 p-3">
        <div className="space-y-0.5">
          <h3 className="truncate text-sm font-bold text-neutral-100">{row.name}</h3>
          <div className="font-mono text-[11px] text-[#CCFF00]/70">${row.symbol}</div>
        </div>
        <div className="space-y-1">
          <p className="font-mono text-sm font-bold text-neutral-100">
            {mc} <span className="text-[10px] font-normal text-neutral-500">MC</span>
          </p>
          <div className="truncate font-mono text-[9px] text-neutral-600">
            {shortAddress(row.address)}
          </div>
        </div>
      </div>
    </Link>
  );
}
