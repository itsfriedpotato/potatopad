"use client";

import { Users } from "lucide-react";
import type { Address } from "viem";
import { useTokenHolders } from "@/lib/events";
import { ZERO_ADDRESS } from "@/lib/config";
import { shortAddress } from "@/lib/format";

/**
 * v2 has no Trade events (all trading happens on the Uniswap pool), so this
 * panel shows holders only, derived client-side from ERC-20 Transfer logs.
 * The pool custodies ~the entire launch supply as single-sided liquidity.
 */
export function ActivityTabs({
  token,
  creator,
  pool,
}: {
  token: Address;
  creator: Address;
  pool: Address;
}) {
  const { holders, total, unavailable, isLoading } = useTokenHolders(token);
  const topHolders = holders.slice(0, 10);

  const WHALE_BPS = 300; // ≥3% of circulating (excluding the pool + creator)
  function holderStatus(address: Address, pctBps: number) {
    const a = address.toLowerCase();
    if (pool !== ZERO_ADDRESS && a === pool.toLowerCase())
      return { text: "Uniswap V3 Pool", emoji: "🦄", tone: "pool" as const };
    if (a === creator.toLowerCase())
      return { text: "creator", emoji: "🌱", tone: "creator" as const };
    if (pctBps >= WHALE_BPS) return { text: "whale alert", emoji: "🐋", tone: "whale" as const };
    return { text: "clean", emoji: "", tone: "clean" as const };
  }

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-bold text-neutral-100">
          <Users className="h-4 w-4 text-amber-500" />
          Holders
        </h3>
        <span className="flex items-center gap-1.5 text-xs font-medium text-amber-500">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          Live
        </span>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="skeleton h-8 w-full" />
          ))}
        </div>
      ) : unavailable ? (
        <p className="mt-6 pb-2 text-center text-sm text-neutral-500">
          History unavailable, this RPC caps log ranges.
        </p>
      ) : topHolders.length === 0 ? (
        <p className="mt-6 pb-2 text-center text-sm text-neutral-500">No holders found.</p>
      ) : (
        <div className="mt-3">
          <ul className="divide-y divide-neutral-800/70">
            {topHolders.map((h, i) => {
              const pctBps = total > 0n ? Number((h.balance * 10000n) / total) : 0;
              const pct = (pctBps / 100).toLocaleString("en-US", {
                maximumFractionDigits: 2,
              });
              const st = holderStatus(h.address, pctBps);
              const toneCls =
                st.tone === "pool"
                  ? "bg-fuchsia-500/10 text-fuchsia-300"
                  : st.tone === "creator"
                    ? "bg-emerald-500/10 text-emerald-400"
                    : st.tone === "whale"
                      ? "bg-red-500/10 text-red-400"
                      : "bg-neutral-800 text-neutral-500";
              return (
                <li
                  key={h.address}
                  className={`flex items-center gap-3 rounded-md py-2.5 text-sm ${st.tone === "whale" ? "-mx-1.5 bg-red-500/[0.06] px-1.5" : ""}`}
                >
                  <span className="w-5 shrink-0 font-mono text-xs text-neutral-600">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-neutral-200">
                      {shortAddress(h.address)}
                    </span>
                    <span
                      className={`ml-2 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold ${toneCls}`}
                    >
                      {st.emoji && <span aria-hidden>{st.emoji}</span>}
                      {st.text}
                    </span>
                  </span>
                  <span className="hidden w-24 sm:block">
                    <span className="block h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
                      <span
                        className={`block h-full rounded-full ${st.tone === "whale" ? "bg-red-500/70" : "bg-amber-500/70"}`}
                        style={{ width: `${Math.min(100, pctBps / 100)}%` }}
                      />
                    </span>
                  </span>
                  <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-neutral-200">
                    {pct}%
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11px] text-neutral-600">
            Computed client-side from Transfer logs (MVP).
          </p>
        </div>
      )}
    </div>
  );
}
