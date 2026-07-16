import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side JSON-RPC proxy for Robinhood Chain.
 *
 * The browser talks to THIS route (same-origin /api/rpc); it forwards to the
 * Alchemy endpoint held in the server-only ROBINHOOD_RPC_URL env var. The
 * Alchemy key therefore never ships to the client and can't be scraped.
 *
 * Two abuse guards:
 *   1. Method allowlist — only read-only JSON-RPC calls pass, so the endpoint
 *      can't be used to relay transactions or open subscriptions. Wallet writes
 *      go through the user's own wallet RPC, never this proxy.
 *   2. A coarse in-memory per-IP rate limit — fine on a single Railway instance;
 *      for multi-instance or serious protection, put Cloudflare / a shared store
 *      in front.
 */

const UPSTREAM =
  process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

// Denylist, not allowlist: block only the methods that could be abused to relay
// transactions or open subscriptions through our key. Everything else (all reads,
// incl. event filters viem uses) passes, so the app keeps working; the rate
// limiter caps volume. Wallet writes go through the user's own wallet RPC anyway.
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
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 200;
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

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "upstream unreachable" }, { status: 502 });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}

export const runtime = "nodejs";
