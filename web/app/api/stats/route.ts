import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Site-wide analytics, aggregated server-side and cached. Token/pool list comes
 * from the shared `loadFeed` scan; 24h volume, market cap, liquidity and trader
 * counts are enriched from GeckoTerminal's multi-pool endpoint.
 *
 * All-time cumulative volume needs a per-pool OHLCV sweep (slow + rate-limited),
 * so it is computed in the BACKGROUND and cached for 30 min — it only grows, so a
 * slightly stale figure is fine, and the request never blocks on it.
 */

export const runtime = "nodejs";

const ZERO = "0x0000000000000000000000000000000000000000";
const STATS_TTL_MS = 60_000;
const ALLTIME_TTL_MS = 30 * 60_000;
const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SiteStats {
  tokensLaunched: number;
  /** tokens with any trading in the last 24h */
  activeTokens: number;
  volume24Usd: number;
  /** cumulative USD volume since launch; null until the first background sweep lands */
  volumeAllTimeUsd: number | null;
  marketCapUsd: number;
  /** single-sided Uniswap V3 liquidity, permanently locked */
  liquidityUsd: number;
  /** unique buyers + sellers across all pools in the last 24h (approx) */
  traders24: number;
  unavailable: boolean;
  updatedAt: number;
}
type BaseStats = Omit<SiteStats, "volumeAllTimeUsd">;

interface PoolAttrs {
  address?: string;
  volume_usd?: { h24?: string };
  market_cap_usd?: string | null;
  fdv_usd?: string | null;
  reserve_in_usd?: string | null;
  transactions?: { h24?: { buyers?: number; sellers?: number } };
}

function geckoBase() {
  const key = process.env.COINGECKO_API_KEY;
  const base = key
    ? "https://pro-api.coingecko.com/api/v3/onchain/networks/robinhood"
    : "https://api.geckoterminal.com/api/v2/networks/robinhood";
  const headers: Record<string, string> = key
    ? { "x-cg-pro-api-key": key, accept: "application/json" }
    : { accept: "application/json" };
  // Pro's limits are generous; the free tier is ~30 req/min, so pace the OHLCV sweep.
  return { base, headers, ohlcvDelay: key ? 300 : 2100 };
}

async function fetchPoolStats(pools: string[]): Promise<Map<string, PoolAttrs>> {
  const out = new Map<string, PoolAttrs>();
  if (pools.length === 0) return out;
  const { base, headers } = geckoBase();
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

// ── all-time volume: background sweep of per-pool daily OHLCV, cached long ──
let allTimeCache: { value: number; computedAt: number } | null = null;
let allTimeInFlight = false;

async function computeAllTimeVolume(pools: string[]): Promise<number> {
  const { base, headers, ohlcvDelay } = geckoBase();
  let total = 0;
  for (const pool of pools) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(
          `${base}/pools/${pool}/ohlcv/day?aggregate=1&limit=1000&currency=usd`,
          { headers, cache: "no-store", signal: AbortSignal.timeout(8000) },
        );
        if (res.status === 429) {
          await sleep(5000);
          continue;
        }
        if (res.ok) {
          const j = (await res.json()) as {
            data?: { attributes?: { ohlcv_list?: number[][] } };
          };
          for (const row of j.data?.attributes?.ohlcv_list ?? []) total += Number(row[5]) || 0;
        }
        break;
      } catch {
        await sleep(1500);
      }
    }
    await sleep(ohlcvDelay);
  }
  return total;
}

/** Kick a background recompute if the cached all-time figure is missing or stale. */
function ensureAllTime(pools: string[]) {
  const now = Date.now();
  const fresh = allTimeCache && now - allTimeCache.computedAt < ALLTIME_TTL_MS;
  if (fresh || allTimeInFlight || pools.length === 0) return;
  allTimeInFlight = true;
  computeAllTimeVolume(pools)
    .then((v) => {
      allTimeCache = { value: v, computedAt: Date.now() };
    })
    .catch(() => {
      /* keep the previous value; retry next tick */
    })
    .finally(() => {
      allTimeInFlight = false;
    });
}

let cache: { stats: BaseStats; expiresAt: number } | null = null;

export async function GET() {
  const now = Date.now();
  const feed = await loadFeed();
  const withPool = feed.creations.filter((c) => c.pool && c.pool.toLowerCase() !== ZERO);
  const pools = withPool.map((c) => c.pool);

  // Refresh all-time volume in the background; attach whatever's cached right now.
  ensureAllTime(pools);
  const volumeAllTimeUsd = allTimeCache?.value ?? null;

  if (cache && cache.expiresAt > now) {
    return NextResponse.json({ ...cache.stats, volumeAllTimeUsd }, { headers: CACHE_HEADERS });
  }

  const attrs = await fetchPoolStats(pools);
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

  const base: BaseStats = {
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
  if (!feed.unavailable) cache = { stats: base, expiresAt: now + STATS_TTL_MS };
  return NextResponse.json({ ...base, volumeAllTimeUsd }, { headers: CACHE_HEADERS });
}
