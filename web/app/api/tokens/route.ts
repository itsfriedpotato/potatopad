import { NextResponse } from "next/server";
import { loadFeed } from "@/lib/tokenFeed";

/**
 * Server-side, cached Discover feed. The scan + cache live in `@/lib/tokenFeed`
 * so the token page's metadata and OG image share the same one-scan-per-TTL feed.
 */

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
};

export async function GET() {
  // loadFeed soft-degrades on RPC failure (last good payload, or unavailable:true),
  // so we always return HTTP 200 and the UI degrades gracefully.
  const payload = await loadFeed();
  return NextResponse.json(payload, { headers: CACHE_HEADERS });
}
