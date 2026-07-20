import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Server-side, cached Discover feed. The scan + cache live in `@/lib/tokenFeed`
 * so the token page's metadata and OG image share the same one-scan-per-TTL feed.
 *
 * `private, no-store` so shared caches never freeze `servedAt` (rolling windows
 * and stale labels depend on a per-response clock).
 */

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export async function GET() {
  // loadFeed soft-degrades on RPC failure (last good payload, or unavailable),
  // so we always return HTTP 200 and the UI degrades gracefully.
  const payload = await loadFeed();
  return NextResponse.json(payload, { headers: CACHE_HEADERS });
}
