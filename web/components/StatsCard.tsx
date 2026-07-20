"use client";

import { Activity } from "lucide-react";
import type { Address } from "viem";
import { useTokenHolders } from "@/lib/events";
import { bpsToPercent, formatEth, formatFloatPrice, formatUsd, formatUsdPrice } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";

export function StatsCard({
  token,
  priceWeth,
  marketCapEth,
  wethInPool,
  onCurve = false,
  progressBps = 0n,
}: {
  token: Address;
  /** WETH per whole token (float) — from the pool, or the curve when onCurve */
  priceWeth: number;
  /** fully-diluted valuation in ETH (float) */
  marketCapEth: number;
  /** WETH held by the pool, or ETH collected on the curve when onCurve */
  wethInPool: bigint | undefined;
  /** True while the token is in the pre-migration bonding-curve phase. */
  onCurve?: boolean;
  /** Curve progress toward the fill/migration price, 0–10000 bps (only when onCurve). */
  progressBps?: bigint;
}) {
  const { holders, unavailable: holdersUnavailable } = useTokenHolders(token);
  const { usd: ethUsd } = useEthUsdPrice();

  const marketCapUsd = ethUsd !== null ? marketCapEth * ethUsd : null;
  const priceUsd = ethUsd !== null && priceWeth > 0 ? priceWeth * ethUsd : null;

  const rows: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Price",
      // USD headline; fall back to the ETH price if the feed is down.
      value:
        priceWeth <= 0
          ? "…"
          : priceUsd !== null
            ? formatUsdPrice(priceUsd)
            : `${formatFloatPrice(priceWeth)} ETH`,
      sub:
        priceUsd !== null && priceWeth > 0 ? `${formatFloatPrice(priceWeth)} ETH` : undefined,
    },
    {
      label: "Market Cap",
      // USD headline; fall back to the ETH-denominated FDV if the feed is down.
      value:
        marketCapEth <= 0
          ? "…"
          : marketCapUsd !== null
            ? formatUsd(marketCapUsd)
            : `${marketCapEth.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETH`,
      sub:
        marketCapUsd !== null && marketCapEth > 0
          ? `${marketCapEth.toLocaleString("en-US", { maximumFractionDigits: 2 })} ETH FDV`
          : undefined,
    },
    {
      label: onCurve ? "Collected" : "Liquidity",
      value:
        wethInPool === undefined ? "…" : `${formatEth(wethInPool)} ${onCurve ? "ETH" : "WETH"}`,
    },
    {
      label: "Holders",
      value: holdersUnavailable ? "n/a" : holders.length.toString(),
    },
  ];

  return (
    <div className="card p-5">
      <h3 className="flex items-center gap-2 font-bold text-neutral-100">
        <Activity className="h-4 w-4 text-amber-500" />
        Stats
      </h3>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className="rounded-lg border border-neutral-800 bg-neutral-950 p-2.5"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              {row.label}
            </p>
            <p className="mt-1 font-mono text-sm tabular-nums text-neutral-100">{row.value}</p>
            {row.sub && (
              <p className="mt-0.5 font-mono text-[10px] tabular-nums text-neutral-500">{row.sub}</p>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-neutral-600">
        {onCurve
          ? `Live on Uniswap · ${bpsToPercent(progressBps)} of the curve sold toward bond.`
          : "Price & market cap from the Uniswap V3 pool. Live on Uniswap."}
      </p>
    </div>
  );
}
