import { NextResponse } from "next/server";
import { loadFeedWithSource } from "@/lib/tokenFeed";

/**
 * Server-side, cached Discover feed. The scan + cache live in `@/lib/tokenFeed`
 * so the token page's metadata and OG image share the same one-scan-per-TTL feed.
 */

export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60",
};

export async function GET() {
  // Adds the source for dev purpose, to check the source of the results.
  const { payload, source } = await loadFeedWithSource();
  return NextResponse.json(payload, {
    headers: { ...CACHE_HEADERS, "x-feed-source": source },
  });
}
