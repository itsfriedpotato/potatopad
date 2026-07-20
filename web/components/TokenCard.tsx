"use client";

import Link from "next/link";
import { getAddress, isAddress, type Address } from "viem";
import { formatUsd, shortAddress, timeAgo } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";
import { TokenAvatar } from "@/components/TokenAvatar";

export interface TokenRow {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  /** The planter's profile name. Falls back to their short address when absent. */
  creatorName?: string;
  pool: Address;
  /** WETH per whole token (float); null when price is unknown / failed. */
  priceWeth: number | null;
  /** fully-diluted valuation in ETH; null when price unknown. */
  marketCapEth: number | null;
  /** TokenCreated block timestamp (unix seconds); undefined if history unavailable */
  createdAt?: number;
  /** launch image URL / ipfs hash from TokenCreated (optional) */
  imageURI?: string;
  /** Ancient (pre-existing Robinhood) token — renders USD stats + an Ancient badge. */
  ancient?: boolean;
  /** Ancient market cap (USD) from GeckoTerminal. */
  marketCapUsd?: number;
  /** 24h volume (USD) from GeckoTerminal / feed. */
  volume24Usd?: number;
}

function creatorHref(creator: Address): string | null {
  if (!isAddress(creator)) return null;
  try {
    return `/creator/${getAddress(creator)}`;
  } catch {
    return null;
  }
}

const cardShell =
  "group flex flex-col overflow-hidden rounded-xl border border-neutral-800/50 bg-neutral-900 shadow-[0_6px_16px_-4px_rgba(0,0,0,0.5),inset_0_1px_0_rgba(255,255,255,0.02)] transition-all duration-200 hover:-translate-y-0.5 hover:border-[#CCFF00]/30 hover:shadow-[0_14px_28px_-8px_rgba(0,0,0,0.6),0_0_18px_rgba(204,255,0,0.06),inset_0_1px_0_rgba(255,255,255,0.03)]";

export function TokenCard({
  row,
  /** When true, omit the planter profile link (e.g. already on that profile). */
  hideCreatorLink = false,
}: {
  row: TokenRow;
  hideCreatorLink?: boolean;
}) {
  const { usd: ethUsd } = useEthUsdPrice();

  const mcapUsd = row.ancient
    ? (row.marketCapUsd ?? 0)
    : ethUsd !== null && row.marketCapEth != null && row.marketCapEth > 0
      ? row.marketCapEth * ethUsd
      : 0;
  const mc = mcapUsd > 0 ? formatUsd(mcapUsd) : "—";
  const profile = !hideCreatorLink && !row.ancient ? creatorHref(row.creator) : null;
  // Prefer the planter's profile name; fall back to the raw address in mono.
  const byLabel = row.creatorName ? (
    row.creatorName
  ) : (
    <span className="font-mono">{shortAddress(row.creator)}</span>
  );

  // ── Ancient card: image, name, MC + 24h VOL, Ancient tag ──
  if (row.ancient) {
    const vol = row.volume24Usd && row.volume24Usd > 0 ? formatUsd(row.volume24Usd) : "—";
    return (
      <Link href={`/token/${row.address}`} className={cardShell}>
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

  // ── PotatoPad card: sibling token + creator destinations (no nested anchors) ──
  return (
    <article className={cardShell}>
      <Link
        href={`/token/${row.address}`}
        className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/60"
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
        <div className="flex flex-1 flex-col justify-between gap-2.5 p-3 pb-1">
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
      {/* Sibling link (not nested): open planter profile without leaving token nav. */}
      {profile ? (
        <div className="border-t border-neutral-800/60 px-3 py-2">
          <Link
            href={profile}
            className="block truncate text-[10px] text-neutral-500 transition-colors hover:text-amber-400 focus-visible:text-amber-400 focus-visible:outline-none"
          >
            by {byLabel}
          </Link>
        </div>
      ) : (
        <div className="border-t border-neutral-800/60 px-3 py-2">
          <span className="block truncate text-[10px] text-neutral-600">
            by {byLabel}
          </span>
        </div>
      )}
    </article>
  );
}
