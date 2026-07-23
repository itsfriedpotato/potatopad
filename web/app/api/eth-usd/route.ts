import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side ETH/USD spot price with a last-good-value guarantee.
 *
 * The client used to hit relay.link / coinbase directly from every visitor's
 * browser: ad blockers kill those domains, rate limits hit per visitor, and
 * any failure blanked every market cap on the site to "—" for a minute.
 * Serving it from here means ONE upstream call per minute for all visitors,
 * no third-party requests from browsers, and a price that survives upstream
 * outages: once a price has been seen, a failure serves the stale value
 * (with its age) instead of nothing. A slightly old ETH price is strictly
 * better than a blank market cap.
 */

const TTL_MS = 60_000;

let lastGood: { usd: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

async function fetchUpstream(): Promise<number | null> {
  // Relay: { price: 1885.25 }
  try {
    const res = await fetch(
      "https://api.relay.link/currencies/token/price?chainId=1&address=0x0000000000000000000000000000000000000000",
      { cache: "no-store", signal: AbortSignal.timeout(4_000) },
    );
    if (res.ok) {
      const j = (await res.json()) as { price?: number };
      if (typeof j?.price === "number" && Number.isFinite(j.price) && j.price > 0) return j.price;
    }
  } catch {
    // next source
  }
  // Coinbase: { data: { amount: "3456.78" } }
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", {
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { data?: { amount?: string } };
      const n = Number(j?.data?.amount);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // next source
  }
  // CoinGecko (keyed if available): { ethereum: { usd: 1885.2 } }
  try {
    const key = process.env.COINGECKO_API_KEY;
    const url = key
      ? `https://pro-api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&x_cg_pro_api_key=${key}`
      : "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4_000) });
    if (res.ok) {
      const j = (await res.json()) as { ethereum?: { usd?: number } };
      const n = j?.ethereum?.usd;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    // out of sources
  }
  return null;
}

export async function GET() {
  const now = Date.now();

  if (!lastGood || now - lastGood.at > TTL_MS) {
    // Single-flight: concurrent requests share one upstream refresh.
    if (!inflight) {
      inflight = fetchUpstream().finally(() => {
        inflight = null;
      });
    }
    const fresh = await inflight;
    if (fresh !== null) lastGood = { usd: fresh, at: Date.now() };
  }

  if (!lastGood) {
    return NextResponse.json({ usd: null }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(
    { usd: lastGood.usd, ageMs: Date.now() - lastGood.at },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=120" } },
  );
}
