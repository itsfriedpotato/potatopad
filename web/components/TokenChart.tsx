"use client";

import { CandlestickChart, ExternalLink, Sprout } from "lucide-react";
import type { Address } from "viem";
import { usePad } from "@/lib/hooks";
import {
  GECKOTERMINAL_NETWORKS,
  ZERO_ADDRESS,
  geckoTerminalPoolUrl,
  uniswapSwapUrl,
} from "@/lib/config";
import { bpsToPercent } from "@/lib/format";
import { useGeckoIndexed } from "@/lib/useGeckoIndexed";
import { ProgressBar } from "@/components/ProgressBar";

/**
 * Price chart for a PotatoPad token. Every token — curve or direct — trades on a
 * real Uniswap V3 pool from block one, so we always embed the GeckoTerminal pool
 * chart (falling back to a "trades on Uniswap" placeholder on networks GT doesn't
 * index yet). Curve tokens additionally get a bonding-curve progress bar UNDER the
 * chart: pre-bond it climbs toward 100%, and once bonded it reads full / locked.
 */
export function TokenChart({
  token,
  pool,
  isCurve = false,
  bonded = false,
  progressBps = 0n,
}: {
  token: Address;
  pool: Address;
  /** True when this token launched on the bonding-curve pad. */
  isCurve?: boolean;
  /** True once the curve bonded (LP permanently locked). */
  bonded?: boolean;
  /** Curve progress toward bond, 0–10000 bps (100% once bonded). */
  progressBps?: bigint;
}) {
  const { chainId } = usePad();
  const hasPool = pool !== ZERO_ADDRESS;
  // Only embed once GeckoTerminal has actually indexed the pool; a brand-new
  // pool would otherwise render GT's own 404 inside the iframe. Flips to the
  // chart automatically once GT catches up (the hook polls while missing).
  const geckoStatus = useGeckoIndexed(
    GECKOTERMINAL_NETWORKS[chainId],
    hasPool ? pool : undefined,
  );
  const embedUrl =
    hasPool && geckoStatus === "indexed" ? geckoTerminalPoolUrl(chainId, pool) : undefined;
  const indexing = hasPool && geckoStatus === "missing";
  // A bonded curve is 100% by definition, regardless of the live pool tick.
  const barBps = bonded ? 10_000n : progressBps;

  return (
    <section className="card p-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 font-semibold text-neutral-100">
          <CandlestickChart className="h-4 w-4 text-amber-500" />
          Price Chart
        </h2>
        {embedUrl && (
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            data by GeckoTerminal
          </span>
        )}
      </div>

      {embedUrl ? (
        <div className="overflow-hidden rounded-lg border border-neutral-800">
          <iframe
            title="GeckoTerminal pool chart"
            src={embedUrl}
            className="h-[420px] w-full"
            // Warm-tint the GeckoTerminal embed so its default palette reads on the
            // amber/potato theme (dark bg + sepia/hue-shift toward amber).
            style={{
              filter: "brightness(1) saturate(0.7) sepia(0.7) contrast(1.6) hue-rotate(-19deg)",
            }}
            frameBorder="0"
            allow="clipboard-write"
            allowFullScreen
          />
        </div>
      ) : (
        <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 text-center">
          <CandlestickChart className="h-8 w-8 text-amber-500/60" aria-hidden />
          <p className="max-w-xs text-sm text-neutral-400">
            {indexing
              ? "Fresh launch — GeckoTerminal is still indexing this pool. The chart appears here automatically within a few minutes. It's already live and tradable."
              : "This token trades live on Uniswap V3. A price chart isn't indexed on this network yet."}
          </p>
          <a
            href={uniswapSwapUrl(token, chainId)}
            target="_blank"
            rel="noreferrer"
            className="btn-secondary px-3 py-1.5 text-xs"
          >
            Trade on Uniswap
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* Bonding-curve progress — shown for every curve token, bonded or not. */}
      {isCurve && (
        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-500">
              <Sprout className="h-3.5 w-3.5" />
              Bonding curve
            </span>
            <span className="text-[11px] font-medium text-neutral-400">
              {bonded ? "🎓 Bonded · LP locked" : "🌱 Bonding"}
            </span>
          </div>
          <ProgressBar bps={barBps} label={bpsToPercent(barBps)} />
          <p className="mt-2 text-[11px] text-neutral-600">
            {bonded
              ? "The curve filled and bonded — 100% of supply is a permanently locked Uniswap V3 position. Swap fees split 50/50 creator / treasury."
              : "It trades on Uniswap now; every buy walks the price up the curve. At 100% it bonds and the position stays locked forever."}
          </p>
        </div>
      )}
    </section>
  );
}
