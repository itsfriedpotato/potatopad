import { NextResponse } from "next/server";

/**
 * Server-side ETH/USD spot price.
 *
 * These lookups used to run in the BROWSER against Relay and Coinbase directly.
 * Both are reachable and fast, but third-party price endpoints are among the
 * most commonly blocked hosts by ad/tracker blockers — `api.coinbase.com`
 * especially. A blocked fetch left `usd` null, and since every PotatoPad card
 * prices its market cap in ETH, the whole feed rendered "—".
 *
 * Fetching here removes the browser from the equation entirely: same-origin, no
 * CORS, nothing for a blocker to match on, and one upstream call shared by every
 * visitor instead of one per tab.
 */

export const runtime = "nodejs";

const RELAY =
  "https://api.relay.link/currencies/token/price?chainId=1&address=0x0000000000000000000000000000000000000000";
const COINBASE = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

/** Spot moves slowly enough that a minute of staleness is invisible here. */
const TTL_MS = 60_000;
/** Don't let one hung upstream hold the response open. */
const UPSTREAM_TIMEOUT_MS = 4_000;

let cache: { usd: number; expiresAt: number } | null = null;

function usable(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

async function withTimeout(url: string): Promise<Response | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctl.signal, cache: "no-store" });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstream(): Promise<number | null> {
  const relay = await withTimeout(RELAY);
  if (relay?.ok) {
    const json = (await relay.json().catch(() => null)) as { price?: number } | null;
    if (usable(json?.price)) return json.price;
  }

  const cb = await withTimeout(COINBASE);
  if (cb?.ok) {
    const json = (await cb.json().catch(() => null)) as { data?: { amount?: string } } | null;
    const amount = Number(json?.data?.amount);
    if (usable(amount)) return amount;
  }

  return null;
}

export async function GET() {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(
      { usd: cache.usd },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
    );
  }

  const usd = await fetchUpstream();
  if (usd === null) {
    // Serve the last good price rather than a null that blanks every market cap.
    // A slightly stale ETH price is far better than none, and the client can tell
    // the difference via `stale`.
    if (cache) {
      return NextResponse.json(
        { usd: cache.usd, stale: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ usd: null }, { headers: { "Cache-Control": "no-store" } });
  }

  cache = { usd, expiresAt: now + TTL_MS };
  return NextResponse.json(
    { usd },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  );
}
