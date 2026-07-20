import { NextRequest, NextResponse } from "next/server";
import { robinhoodPrimaryPool, robinhoodFallbacks, PUBLIC_RPC } from "@/lib/serverRpc";

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
 * Two tiers: the PRIMARY POOL (Chainstack nodes in ROBINHOOD_RPC_URL, _2, _3) is
 * round-robined so load spreads evenly and no single node hits its ~250 req/s limit;
 * FALLBACKS (Alchemy in ROBINHOOD_RPC_FALLBACK_URL, _2) then the public RPC catch a
 * 429/5xx spillover. Add pool nodes or fallbacks via those env vars.
 */

// The Chainstack pool is round-robined (spread load); Alchemy + public back it up.
// Keys live only in these server env vars, so they never ship to the browser — which
// talks to this same-origin proxy, not the keyed endpoints.
const POOL = robinhoodPrimaryPool();
const FALLBACKS = [...robinhoodFallbacks(), PUBLIC_RPC];
// Round-robin cursor across the pool (module-level; approximate under concurrency,
// which is fine — the goal is spreading load, not perfect fairness).
let rrCursor = 0;

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
//
// NOTE: the per-IP key comes from `x-forwarded-for` / `x-real-ip`, which are
// client-settable. Unless a fixed upstream proxy (Railway/Cloudflare) is
// guaranteed to overwrite them, a caller can rotate the header per request and
// evade the per-IP cap entirely. So the per-IP limit is only a soft signal; the
// GLOBAL backstop below is the unspoofable ceiling that actually protects the
// shared Alchemy key from being drained by header rotation.
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 500;
const hits = new Map<string, number[]>();

// Global backstop across ALL callers — independent of the (spoofable) IP key.
// Generous enough for real concurrent traffic (~10x a single heavy client) but
// a hard cap on outright abuse. Tune via env for multi-instance deploys.
const MAX_GLOBAL_PER_WINDOW = Number(process.env.RPC_MAX_GLOBAL_PER_WINDOW) || 5_000;
let globalHits: number[] = [];

// One request can't smuggle thousands of expensive reads: cap the batch size and
// the body, and charge the limiter PER JSON-RPC CALL below (not per HTTP request).
const MAX_BATCH = 100;
const MAX_BODY_BYTES = 512 * 1024;

function globalRateLimited(cost: number): boolean {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < WINDOW_MS);
  for (let i = 0; i < cost; i++) globalHits.push(now);
  return globalHits.length > MAX_GLOBAL_PER_WINDOW;
}

function rateLimited(ip: string, cost: number): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  for (let i = 0; i < cost; i++) recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

/**
 * Forward the JSON-RPC body: round-robin the primary pool so each Chainstack node
 * takes ~1/N of traffic (staying under its per-node rate limit), then fall through
 * the rest of the pool and the fallbacks (Alchemy, then public) on a 429 or 5xx.
 * Returns the first response that is neither, or the last throttled/errored one if
 * every upstream is exhausted.
 */
async function forward(bodyStr: string): Promise<{ status: number; text: string }> {
  // This request's try-order: a round-robin start within the pool, then the rest of
  // the pool, then the fallbacks. De-duped, and falls back to public if pool empty.
  const order: string[] = [];
  const n = POOL.length;
  if (n > 0) {
    const start = rrCursor;
    rrCursor = (rrCursor + 1) % n;
    for (let i = 0; i < n; i++) order.push(POOL[(start + i) % n]);
  }
  order.push(...FALLBACKS);
  const tryList = [...new Set(order)];

  let last: { status: number; text: string } | null = null;
  for (const url of tryList) {
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

  // Same-origin guard: this proxy is for THIS app's browser. Block cross-origin
  // browser callers so another site can't use our keyed upstreams as a free RPC.
  // A missing Origin (server-to-server, curl) is allowed but still rate-limited.
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.get("host")) {
        return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
    }
  }

  // Reject oversized bodies before reading them — a huge batch is the drain vector.
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_BATCH) {
    return NextResponse.json({ error: `batch too large (max ${MAX_BATCH})` }, { status: 413 });
  }

  // Charge PER JSON-RPC call, so a batch can't multiply cost past the cap.
  const cost = calls.length || 1;
  if (globalRateLimited(cost) || rateLimited(ip, cost)) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  for (const c of calls) {
    const method = (c as { method?: unknown })?.method;
    if (typeof method === "string" && BLOCKED_METHODS.has(method)) {
      return NextResponse.json({ error: `method not allowed: ${method}` }, { status: 403 });
    }
  }

  const { status, text } = await forward(JSON.stringify(body));
  return new NextResponse(text, {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const runtime = "nodejs";
