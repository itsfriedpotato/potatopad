"use client";

import { CandlestickChart, ExternalLink } from "lucide-react";
import type { Address } from "viem";
import { usePad } from "@/lib/hooks";
import { ZERO_ADDRESS, geckoTerminalPoolUrl, uniswapSwapUrl } from "@/lib/config";

/**
 * v2 chart: every token is live on Uniswap V3 from launch, so we chart the real
 * pool. On a GeckoTerminal-indexed network we embed the GT pool chart (real DEX
 * candles, liquidity + volume). Elsewhere (testnets / local) we show a simple
 * "trades on Uniswap" placeholder — there are no Trade events to rebuild from.
 */
export function TokenChart({ token, pool }: { token: Address; pool: Address }) {
  const { chainId } = usePad();
  const embedUrl =
    pool !== ZERO_ADDRESS ? geckoTerminalPoolUrl(chainId, pool) : undefined;

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
            This token trades live on Uniswap V3. A price chart isn&apos;t indexed on
            this network yet.
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
    </section>
  );
}
