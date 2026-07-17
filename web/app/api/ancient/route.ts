import { NextRequest, NextResponse } from "next/server";
import { robinhoodChain, WETH_ADDRESSES } from "@/lib/config";

/**
 * "Ancient" tokens: pre-existing Robinhood runners (Noxa etc.) that were NOT
 * launched on PotatoPad. We surface them read-only in an Ancient section. Data
 * comes from CoinGecko's on-chain (GeckoTerminal) pools API — top pools by
 * volume/liquidity — and is cached server-side so the CoinGecko key stays hidden
 * and every visitor gets a small pre-built list.
 */

export const runtime = "nodejs";

const NETWORK = "robinhood";
const WETH = (WETH_ADDRESSES[robinhoodChain.id] ?? "").toLowerCase();
// Tokens that are the QUOTE side of a pair, never the "runner" we want to list.
const QUOTE_SYMBOLS = new Set(["WETH", "ETH", "USDG", "USDC", "USDT", "DAI", "USDC.E"]);
const QUOTE_ADDRS = new Set([WETH]);
const PAGES = 3;
const MAX_TOKENS = 60;

export interface AncientTokenDto {
  address: string;
  name: string;
  symbol: string;
  /** Highest-liquidity WETH pool, for in-app trading (ZERO if none). */
  tradePool: string;
  /** Fee tier (bps) of `tradePool`, for the swap/quote. */
  feeTier: number;
  fdvUsd: number;
  volume24Usd: number;
  liquidityUsd: number;
  hasWethPool: boolean;
}

interface Payload {
  tokens: AncientTokenDto[];
  unavailable: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

function stripPrefix(id: string): string {
  const i = id.indexOf("_");
  return i >= 0 ? id.slice(i + 1) : id;
}

/** "CASHCAT / WETH 1%" -> 10000 bps; "… 0.3%" -> 3000; default 1% tier. */
function feeFromName(name: string | undefined): number {
  const m = (name ?? "").match(/([\d.]+)\s*%/);
  if (!m) return 10_000;
  return Math.round(parseFloat(m[1]) * 10_000);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchPools(page: number): Promise<{ data: any[]; included: any[] }> {
  const key = process.env.COINGECKO_API_KEY;
  const qs = `include=base_token,quote_token&page=${page}`;
  const url = key
    ? `https://pro-api.coingecko.com/api/v3/onchain/networks/${NETWORK}/pools?${qs}`
    : `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools?${qs}`;
  const res = await fetch(url, {
    headers: key
      ? { "x-cg-pro-api-key": key, accept: "application/json" }
      : { accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`pools ${res.status}`);
  const j = await res.json();
  return { data: j.data ?? [], included: j.included ?? [] };
}

async function padTokenSet(req: NextRequest): Promise<Set<string>> {
  // Exclude PotatoPad launches — they're "ours", not ancient.
  try {
    const res = await fetch(new URL("/api/tokens", req.url), { cache: "no-store" });
    if (!res.ok) return new Set();
    const j = (await res.json()) as { creations?: Array<{ token?: string }> };
    return new Set((j.creations ?? []).map((c) => (c.token ?? "").toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

type Agg = {
  address: string;
  name: string;
  symbol: string;
  fdvUsd: number;
  volume24Usd: number;
  liquidityUsd: number; // of the best (highest-liq) pool overall
  bestPoolLiq: number;
  tradePool: string;
  feeTier: number;
  bestWethLiq: number; // highest-liq WETH pool seen
};

async function build(req: NextRequest): Promise<Payload> {
  const excluded = await padTokenSet(req);
  const tokens = new Map<string, any>(); // id -> token attributes
  const pools: any[] = [];
  for (let p = 1; p <= PAGES; p++) {
    try {
      const { data, included } = await fetchPools(p);
      for (const t of included) if (t?.type === "token") tokens.set(t.id, t.attributes ?? {});
      pools.push(...data);
    } catch {
      if (p === 1) throw new Error("no data");
      break; // partial pages are fine
    }
  }

  const isQuote = (attr: any): boolean => {
    const addr = (attr?.address ?? "").toLowerCase();
    const sym = (attr?.symbol ?? "").toUpperCase();
    return QUOTE_ADDRS.has(addr) || QUOTE_SYMBOLS.has(sym);
  };

  const agg = new Map<string, Agg>();
  for (const pool of pools) {
    const a = pool.attributes ?? {};
    const baseId = pool.relationships?.base_token?.data?.id;
    const quoteId = pool.relationships?.quote_token?.data?.id;
    const base = tokens.get(baseId);
    const quote = tokens.get(quoteId);
    if (!base || !quote) continue;

    // The "ancient token" is the non-quote side; skip stable/WETH-only pairs.
    let tok = base;
    let other = quote;
    if (isQuote(base) && !isQuote(quote)) {
      tok = quote;
      other = base;
    } else if (isQuote(base) && isQuote(quote)) {
      continue;
    }
    const address = (tok.address ?? "").toLowerCase();
    if (!address || excluded.has(address)) continue;

    const poolAddr = stripPrefix(pool.id);
    const fee = feeFromName(a.name);
    const liq = Number(a.reserve_in_usd) || 0;
    const vol = Number(a.volume_usd?.h24) || 0;
    const fdv = Number(a.fdv_usd) || Number(a.market_cap_usd) || 0;
    const otherIsWeth = (other.address ?? "").toLowerCase() === WETH;

    const prev = agg.get(address);
    const cur: Agg = prev ?? {
      address,
      name: tok.name ?? tok.symbol ?? "",
      symbol: tok.symbol ?? "",
      fdvUsd: 0,
      volume24Usd: 0,
      liquidityUsd: 0,
      bestPoolLiq: -1,
      tradePool: ZERO,
      feeTier: 10_000,
      bestWethLiq: -1,
    };
    // Headline stats come from the deepest pool overall.
    if (liq > cur.bestPoolLiq) {
      cur.bestPoolLiq = liq;
      cur.liquidityUsd = liq;
      cur.fdvUsd = fdv || cur.fdvUsd;
    }
    cur.volume24Usd += vol; // aggregate volume across the token's pools
    if (fdv > cur.fdvUsd) cur.fdvUsd = fdv;
    // Trading needs a WETH pool; pick the deepest one.
    if (otherIsWeth && liq > cur.bestWethLiq) {
      cur.bestWethLiq = liq;
      cur.tradePool = poolAddr;
      cur.feeTier = fee;
    }
    agg.set(address, cur);
  }

  const list: AncientTokenDto[] = [...agg.values()]
    .map((a) => ({
      address: a.address,
      name: a.name,
      symbol: a.symbol,
      tradePool: a.tradePool,
      feeTier: a.feeTier,
      fdvUsd: a.fdvUsd,
      volume24Usd: a.volume24Usd,
      liquidityUsd: a.liquidityUsd,
      hasWethPool: a.bestWethLiq >= 0,
    }))
    .sort((x, y) => y.liquidityUsd - x.liquidityUsd)
    .slice(0, MAX_TOKENS);

  return { tokens: list, unavailable: false };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let cache: { payload: Payload; expiresAt: number } | null = null;
const TTL_MS = 5 * 60_000;

export async function GET(req: NextRequest) {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(cache.payload, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    });
  }
  try {
    const payload = await build(req);
    cache = { payload, expiresAt: now + TTL_MS };
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" },
    });
  } catch {
    if (cache) return NextResponse.json(cache.payload); // serve last-good on failure
    return NextResponse.json({ tokens: [], unavailable: true } satisfies Payload);
  }
}
