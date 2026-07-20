import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Server-side, cached Discover feed. The scan + cache live in `@/lib/tokenFeed`
 * so the token page's metadata and OG image share the same one-scan-per-TTL feed.
 *
 * `private, no-store` so shared caches never freeze `servedAt` (rolling windows
 * and stale labels depend on a per-response clock).
 *
 * Query:
 * - `force=1` — bypass the normal 90s TTL (Plant create pre-submit revalidation).
 *   Discover should omit this so the shared cache still absorbs traffic.
 *   New forced *scans* are rate-limited (global + per-IP) inside `loadFeed` after
 *   forceInFlight coalescing; over limit returns `unavailable` so create stays
 *   fail-closed without free RPC DoS.
 */

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

// Forced full-history multi-pad scans are expensive. Same pattern as /api/holders:
// per-IP is soft (X-Forwarded-For spoofable); GLOBAL is the unspoofable ceiling.
const FORCE_RL_WINDOW_MS = 60_000;
const FORCE_RL_MAX_PER_IP = 6;
const FORCE_RL_MAX_GLOBAL =
  Number(process.env.TOKENS_FORCE_MAX_GLOBAL_PER_WINDOW) || 30;
const forceIpHits = new Map<string, number[]>();
let forceGlobalHits: number[] = [];

function forceRateLimited(ip: string): boolean {
  const now = Date.now();
  // Check BEFORE recording so over-limit traffic does not grow the arrays.
  forceGlobalHits = forceGlobalHits.filter((t) => now - t < FORCE_RL_WINDOW_MS);
  if (forceGlobalHits.length >= FORCE_RL_MAX_GLOBAL) return true;

  const recent = (forceIpHits.get(ip) ?? []).filter(
    (t) => now - t < FORCE_RL_WINDOW_MS,
  );
  if (recent.length >= FORCE_RL_MAX_PER_IP) return true;

  forceGlobalHits.push(now);
  recent.push(now);
  forceIpHits.set(ip, recent);
  if (forceIpHits.size > 5000) {
    for (const [k, v] of forceIpHits) {
      if (v.every((t) => now - t >= FORCE_RL_WINDOW_MS)) forceIpHits.delete(k);
    }
  }
  return false;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

export async function GET(request: Request) {
  // loadFeed soft-degrades on RPC failure (last good payload, or unavailable),
  // so we always return HTTP 200 and the UI degrades gracefully.
  const force = new URL(request.url).searchParams.get("force") === "1";
  const ip = clientIp(request);

  const payload = await loadFeed({
    force,
    // Only charged when loadFeed is about to start a new forced scan
    // (after forceInFlight coalesce).
    consumeForceQuota: force ? () => forceRateLimited(ip) : undefined,
  });
  return NextResponse.json(payload, { headers: CACHE_HEADERS });
}
