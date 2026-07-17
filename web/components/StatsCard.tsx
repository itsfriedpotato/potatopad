"use client";

import { Activity } from "lucide-react";
import type { Address } from "viem";
import { useTokenHolders } from "@/lib/events";
import { formatEth, formatFloatPrice, formatUsd, formatUsdPrice } from "@/lib/format";
import { useEthUsdPrice } from "@/lib/price";

export function StatsCard({
  token,
  priceWeth,
  marketCapEth,
  wethInPool,
}: {
  token: Address;
  /** WETH per whole token (float) from the pool */
  priceWeth: number;
  /** fully-diluted valuation in ETH (float) */
  marketCapEth: number;
  /** WETH held by the pool (rough TVL proxy) */
  wethInPool: bigint | undefined;
}) {
  const { holders, unavailable: holdersUnavailable } = useTokenHolders(token);
  const { usd: ethUsd } = useEthUsdPrice();

  const marketCapUsd = ethUsd !== null ? marketCapEth * ethUsd : null;
  const priceUsd = ethUsd !== null && priceWeth > 0 ? priceWeth * ethUsd : null;

  const rows: Array<{ label: string; value: string; sub?: string }> = [
    {
      label: "Price",
      value: priceWeth > 0 ? `${formatFloatPrice(priceWeth)} ETH` : "…",
      sub: priceUsd !== null ? formatUsdPrice(priceUsd) : undefined,
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
      label: "Liquidity",
      value:
        wethInPool === undefined ? "…" : `${formatEth(wethInPool)} WETH`,
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
        Price &amp; market cap from the Uniswap V3 pool. Live on Uniswap since launch.
      </p>
    </div>
  );
}
