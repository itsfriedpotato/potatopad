import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Site-wide analytics, aggregated server-side and cached. Token/pool list comes
 * from the shared `loadFeed` scan; 24h volume, market cap, liquidity and trader
 * counts are enriched from GeckoTerminal's multi-pool endpoint (the reliable one).
 *
 * All-time cumulative volume is deliberately NOT computed here — summing per-pool
 * OHLCV across every token is slow and rate-limited into inaccuracy; an honest 24h
 * window beats a flaky lifetime number. That needs a dedicated indexer.
 */

export const runtime = "nodejs";

const ZERO = "0x0000000000000000000000000000000000000000";
const STATS_TTL_MS = 60_000;
const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" };

export interface SiteStats {
  tokensLaunched: number;
  /** tokens with any trading in the last 24h */
  activeTokens: number;
  volume24Usd: number;
  marketCapUsd: number;
  /** single-sided Uniswap V3 liquidity, permanently locked */
  liquidityUsd: number;
  /** unique buyers + sellers across all pools in the last 24h (approx) */
  traders24: number;
  unavailable: boolean;
  updatedAt: number;
}

interface PoolAttrs {
  address?: string;
  volume_usd?: { h24?: string };
  market_cap_usd?: string | null;
  fdv_usd?: string | null;
  reserve_in_usd?: string | null;
  transactions?: { h24?: { buyers?: number; sellers?: number } };
}

let cache: { stats: SiteStats; expiresAt: number } | null = null;

async function fetchPoolStats(pools: string[]): Promise<Map<string, PoolAttrs>> {
  const out = new Map<string, PoolAttrs>();
  if (pools.length === 0) return out;
  const key = process.env.COINGECKO_API_KEY;
  const base = key
    ? "https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood"
    : "https://api.geckoterminal.com/api/v2/networks/robinhood";
  const headers: Record<string, string> = key
    ? { "x-cg-pro-api-key": key, accept: "application/json" }
    : { accept: "application/json" };
  for (let i = 0; i < pools.length; i += 30) {
    const chunk = pools.slice(i, i + 30);
    try {
      const res = await fetch(`${base}/pools/multi/${chunk.join(",")}`, {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { data?: { attributes?: PoolAttrs }[] };
      for (const d of j.data ?? []) {
        const a = d.attributes;
        const addr = (a?.address ?? "").toLowerCase();
        if (addr && a) out.set(addr, a);
      }
    } catch {
      // best-effort — a chunk miss just leaves those pools out of the totals
    }
  }
  return out;
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.stats, { headers: CACHE_HEADERS });
  }

  const feed = await loadFeed();
  const withPool = feed.creations.filter((c) => c.pool && c.pool.toLowerCase() !== ZERO);
  const attrs = await fetchPoolStats(withPool.map((c) => c.pool));

  let volume24Usd = 0;
  let marketCapUsd = 0;
  let liquidityUsd = 0;
  let traders24 = 0;
  let activeTokens = 0;
  for (const c of withPool) {
    const a = attrs.get(c.pool.toLowerCase());
    if (!a) continue;
    const v = Number(a.volume_usd?.h24) || 0;
    volume24Usd += v;
    if (v > 0) activeTokens++;
    marketCapUsd += Number(a.market_cap_usd ?? a.fdv_usd) || 0;
    liquidityUsd += Number(a.reserve_in_usd) || 0;
    const tx = a.transactions?.h24 ?? {};
    traders24 += (Number(tx.buyers) || 0) + (Number(tx.sellers) || 0);
  }

  const stats: SiteStats = {
    tokensLaunched: feed.creations.length,
    activeTokens,
    volume24Usd,
    marketCapUsd,
    liquidityUsd,
    traders24,
    unavailable: feed.unavailable,
    updatedAt: now,
  };
  // Only cache a healthy result; a degraded feed shouldn't stick for the TTL.
  if (!feed.unavailable) cache = { stats, expiresAt: now + STATS_TTL_MS };
  return NextResponse.json(stats, { headers: CACHE_HEADERS });
}
