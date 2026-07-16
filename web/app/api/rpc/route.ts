import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side JSON-RPC proxy for Robinhood Chain.
 *
 * The browser talks to THIS route (same-origin /api/rpc); it forwards to the
 * Alchemy endpoint(s) held in server-only env vars. The Alchemy keys therefore
 * never ship to the client and can't be scraped.
 *
 * Two abuse guards:
 *   1. Method denylist — block only methods that could relay transactions or
 *      open subscriptions through our key. Everything else (all reads, incl. the
 *      event filters viem uses) passes. Wallet writes go through the user's own
 *      wallet RPC, never this proxy.
 *   2. A coarse in-memory per-IP rate limit — fine on a single Railway instance;
 *      for multi-instance or serious protection, put Cloudflare / a shared store
 *      in front.
 *
 * Multiple upstreams: requests are round-robined across every configured Alchemy
 * endpoint and fail over to the next on a 429 (compute-unit limit) or 5xx, so a
 * spike on one key spills to another instead of surfacing as an error. Add more
 * keys via ROBINHOOD_RPC_URL, ROBINHOOD_RPC_URL_2, ROBINHOOD_RPC_URL_3.
 */

const UPSTREAMS = [
  process.env.ROBINHOOD_RPC_URL,
  process.env.ROBINHOOD_RPC_URL_2,
  process.env.ROBINHOOD_RPC_URL_3,
].filter((u): u is string => !!u && u.length > 0);
if (UPSTREAMS.length === 0) UPSTREAMS.push("https://rpc.mainnet.chain.robinhood.com");

// Denylist, not allowlist: block only the methods that could be abused to relay
// transactions or open subscriptions through our key.
const BLOCKED_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "eth_sign",
  "eth_signTransaction",
  "eth_signTypedData",
  "eth_signTypedData_v4",
  "personal_sign",
  "eth_subscribe",
  "eth_unsubscribe",
]);

// Coarse per-IP sliding-window limiter (in-memory; nodejs runtime keeps it warm).
// Sized for the app's own read bursts (multi-pad log scans + multicalls) while
// still capping outright abuse.
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 500;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

// Round-robin starting point across upstreams; module-level so it persists warm.
let rrCounter = 0;

/**
 * Forward the JSON-RPC body to the upstreams. Starts at a round-robin offset and
 * fails over to the next upstream on a 429 or 5xx. Returns the first response
 * that is neither, or the last throttled/errored response if all are exhausted.
 */
async function forward(bodyStr: string): Promise<{ status: number; text: string }> {
  const n = UPSTREAMS.length;
  const start = rrCounter++ % n;
  let last: { status: number; text: string } | null = null;
  for (let i = 0; i < n; i++) {
    const url = UPSTREAMS[(start + i) % n];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyStr,
        cache: "no-store",
      });
      const text = await res.text();
      if (res.status !== 429 && res.status < 500) return { status: res.status, text };
      last = { status: res.status, text }; // 429 / 5xx — try the next upstream
    } catch {
      // network error — try the next upstream
    }
  }
  return last ?? { status: 502, text: JSON.stringify({ error: "upstream unreachable" }) };
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const calls = Array.isArray(body) ? body : [body];
  for (const c of calls) {
    const method = (c as { method?: unknown })?.method;
    if (typeof method === "string" && BLOCKED_METHODS.has(method)) {
      return NextResponse.json(
        { error: `method not allowed: ${method}` },
        { status: 403 },
      );
    }
  }

  const { status, text } = await forward(JSON.stringify(body));
  return new NextResponse(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const runtime = "nodejs";
