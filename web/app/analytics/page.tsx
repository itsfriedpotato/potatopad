"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, Coins, Lock, Rocket, TrendingUp, Users } from "lucide-react";
import { formatUsd } from "@/lib/format";

interface SiteStats {
  tokensLaunched: number;
  activeTokens: number;
  volume24Usd: number;
  volumeAllTimeUsd: number | null;
  tradesAllTime: number | null;
  marketCapUsd: number;
  liquidityUsd: number;
  traders24: number;
  trades24: number;
  unavailable: boolean;
  updatedAt: number;
}

const fmtNum = (n: number) => n.toLocaleString("en-US");
const fmtUsd = (n: number) => (n > 0 ? formatUsd(n) : "$0");

export default function AnalyticsPage() {
  const { data, isLoading, isError } = useQuery<SiteStats>({
    queryKey: ["site-stats"],
    queryFn: async () => {
      const r = await fetch("/api/stats");
      if (!r.ok) throw new Error("stats unavailable");
      return (await r.json()) as SiteStats;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const cards: {
    label: string;
    value: string;
    hint: string;
    icon: typeof Rocket;
    accent: string;
  }[] = [
    {
      label: "Volume · all-time",
      value: data
        ? data.volumeAllTimeUsd != null
          ? fmtUsd(data.volumeAllTimeUsd)
          : "computing…"
        : "…",
      hint: "cumulative since launch",
      icon: BarChart3,
      accent: "text-amber-400",
    },
    {
      label: "Tokens launched",
      value: data ? fmtNum(data.tokensLaunched) : "…",
      hint: data ? `${fmtNum(data.activeTokens)} traded in the last 24h` : "on PotatoPad",
      icon: Rocket,
      accent: "text-amber-400",
    },
    {
      label: "Volume · 24h",
      value: data ? fmtUsd(data.volume24Usd) : "…",
      hint: "across every pad token",
      icon: TrendingUp,
      accent: "text-emerald-400",
    },
    {
      label: "Trades · all-time",
      value: data
        ? data.tradesAllTime != null
          ? fmtNum(data.tradesAllTime)
          : "computing…"
        : "…",
      hint: "total swaps across all pools",
      icon: Activity,
      accent: "text-emerald-400",
    },
    {
      label: "Traders · 24h",
      value: data ? fmtNum(data.traders24) : "…",
      hint: "buyers + sellers, all pools",
      icon: Users,
      accent: "text-sky-400",
    },
    {
      label: "Market cap",
      value: data ? fmtUsd(data.marketCapUsd) : "…",
      hint: "combined, all pad tokens",
      icon: Coins,
      accent: "text-amber-400",
    },
    {
      label: "Liquidity locked",
      value: data ? fmtUsd(data.liquidityUsd) : "…",
      hint: "single-sided on Uniswap V3, forever",
      icon: Lock,
      accent: "text-fuchsia-400",
    },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-neutral-100">Analytics</h1>
        <p className="mt-1 text-xs text-neutral-500">
          Live across every token launched on PotatoPad. All-time volume + trades are summed on-chain;
          24h figures and market data are by GeckoTerminal.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.label}
              className="rounded-xl border border-neutral-800/60 bg-neutral-950 p-4"
            >
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-neutral-500">
                <Icon className={`h-3.5 w-3.5 ${c.accent}`} />
                {c.label}
              </div>
              <p className="mt-2 font-mono text-2xl font-bold tabular-nums text-neutral-100">
                {isLoading ? <span className="text-neutral-600">…</span> : c.value}
              </p>
              <p className="mt-0.5 text-[11px] text-neutral-600">{c.hint}</p>
            </div>
          );
        })}
      </div>

      {isError && (
        <p className="text-xs text-rose-400">Couldn&apos;t load stats right now — refreshing shortly.</p>
      )}
      {data?.unavailable && (
        <p className="text-xs text-amber-500/80">
          The feed is refreshing — these numbers may be briefly incomplete.
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-neutral-600">
        All-time volume is summed from each pool&apos;s on-chain daily trade history and refreshes
        every few minutes; 24h volume, trades, traders, market cap and liquidity update continuously.
        Data by GeckoTerminal.
      </p>
    </div>
  );
}
