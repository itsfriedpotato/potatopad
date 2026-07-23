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

// ── Read micro-cache + in-flight coalescing ────────────────────────────────
// Under load (a coin pumping), hundreds of browsers poll IDENTICAL reads —
// the same Multicall3 eth_call, the same slot0, the same getLogs window.
// Without this, every one is a full upstream round-trip: the event loop
// saturates, upstreams rate-limit, and the site 502s (observed live during
// the first CHIP run at $1M). A 2s TTL turns N identical polls into 1
// upstream call; the inflight map additionally collapses CONCURRENT misses
// for the same key into a single fetch. Writes and tx-status reads are
// deliberately never cached.
const CACHEABLE = new Set([
  "eth_call",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_chainId",
  "eth_getCode",
  "eth_getStorageAt",
]);
const DEFAULT_TTL_MS = 2_000;
const TTL_MS: Record<string, number> = {
  eth_chainId: 3_600_000, // immutable per chain
  eth_getCode: 60_000, // contracts don't change bytecode
};
type CachedRead = { at: number; ttl: number; result: unknown };
const readCache = new Map<string, CachedRead>();
// key → promise resolving to the upstream `result` (undefined on failure).
const inflight = new Map<string, Promise<unknown>>();

type RpcCall = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

function cacheKey(c: RpcCall): string | null {
  if (typeof c?.method !== "string" || !CACHEABLE.has(c.method)) return null;
  try {
    return c.method + ":" + JSON.stringify(c.params ?? []);
  } catch {
    return null;
  }
}

function sweepCache(now: number) {
  if (readCache.size <= 5_000) return;
  for (const [k, v] of readCache) {
    if (now - v.at >= v.ttl) readCache.delete(k);
  }
}

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
        // Healthy upstreams answer in <200ms; without a per-fetch deadline a
        // hanging node makes the whole fallthrough chain stack to 15s+ and the
        // request pile-up is what actually takes the site down.
        signal: AbortSignal.timeout(3_500),
      });
      const text = await res.text();
      if (res.status !== 429 && res.status < 500) return { status: res.status, text };
      last = { status: res.status, text }; // 429 / 5xx — try the next upstream
    } catch {
      // network error / timeout — try the next upstream
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

  const single = !Array.isArray(body);
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_BATCH) {
    return NextResponse.json({ error: `batch too large (max ${MAX_BATCH})` }, { status: 413 });
  }

  for (const c of calls) {
    const method = (c as { method?: unknown })?.method;
    if (typeof method === "string" && BLOCKED_METHODS.has(method)) {
      return NextResponse.json({ error: `method not allowed: ${method}` }, { status: 403 });
    }
  }

  // Resolve what we can from the read-cache first; only the misses cost anything.
  type Slot = { call: RpcCall; key: string | null; response?: unknown };
  const slots: Slot[] = calls.map((c) => ({ call: c as RpcCall, key: cacheKey(c as RpcCall) }));
  const now = Date.now();
  for (const s of slots) {
    if (!s.key) continue;
    const hit = readCache.get(s.key);
    if (hit && now - hit.at < hit.ttl) {
      s.response = { jsonrpc: "2.0", id: s.call.id ?? null, result: hit.result };
    }
  }

  // Coalesce onto identical calls already in flight from OTHER requests.
  const waits: Promise<void>[] = [];
  for (const s of slots) {
    if (s.response || !s.key) continue;
    const p = inflight.get(s.key);
    if (p) {
      waits.push(
        p.then((result) => {
          if (result !== undefined) {
            s.response = { jsonrpc: "2.0", id: s.call.id ?? null, result };
          }
        }),
      );
    }
  }
  if (waits.length) await Promise.all(waits);

  const misses = slots.filter((s) => !s.response);

  // Charge the limiters ONLY for calls that will hit an upstream — cache hits
  // are near-free CPU and shouldn't burn a real user's window during a pump.
  if (misses.length > 0 && (globalRateLimited(misses.length) || rateLimited(ip, misses.length))) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  if (misses.length > 0) {
    // Register in-flight promises so concurrent requests coalesce onto ours.
    const resolvers = new Map<string, (r: unknown) => void>();
    for (const s of misses) {
      if (!s.key || inflight.has(s.key)) continue;
      let resolve!: (r: unknown) => void;
      const p = new Promise<unknown>((res) => (resolve = res));
      inflight.set(s.key, p);
      resolvers.set(s.key, resolve);
      void p.finally(() => {
        if (inflight.get(s.key!) === p) inflight.delete(s.key!);
      });
    }

    try {
      const fwdBody =
        single && misses.length === 1
          ? JSON.stringify(misses[0].call)
          : JSON.stringify(misses.map((s) => s.call));
      const { status, text } = await forward(fwdBody);

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON upstream error body — handled below as a miss
      }
      const arr: Array<{ id?: unknown; result?: unknown; error?: unknown }> = Array.isArray(parsed)
        ? parsed
        : parsed
          ? [parsed as { id?: unknown }]
          : [];
      const byId = new Map(arr.map((r) => [r?.id, r]));

      const stamp = Date.now();
      for (const s of misses) {
        const r =
          byId.get(s.call.id) ?? (misses.length === 1 && arr.length === 1 ? arr[0] : undefined);
        if (r) {
          s.response = { ...r, id: s.call.id ?? r.id ?? null };
          if (s.key && r.error === undefined) {
            readCache.set(s.key, {
              at: stamp,
              ttl: TTL_MS[s.call.method!] ?? DEFAULT_TTL_MS,
              result: r.result,
            });
            resolvers.get(s.key)?.(r.result);
          }
        }
      }
      sweepCache(stamp);

      // Upstream gave us nothing usable for at least one call — return its raw
      // reply verbatim (same behavior the route always had on failure).
      if (slots.some((s) => !s.response)) {
        return new NextResponse(text, { status, headers: { "content-type": "application/json" } });
      }
    } finally {
      // Any resolver not already fired resolves undefined so coalesced waiters
      // fall through to their own retry rather than hanging forever.
      for (const res of resolvers.values()) res(undefined);
    }
  }

  return NextResponse.json(single ? slots[0].response : slots.map((s) => s.response));
}

export const runtime = "nodejs";
