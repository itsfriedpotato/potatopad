import { NextResponse } from "next/server";
import { currentRound, potUsd } from "@/lib/feedback/rewards";

export const runtime = "nodejs";

const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" };

// GET /api/feedback/rewards — public sidebar data: the open round and the fixed
// weekly reward pot (USD). The round degrades to null on a store blip without
// affecting the pot.
export async function GET() {
  const round = await currentRound().catch(() => null);
  return NextResponse.json({ round, potUsd: potUsd(), cadence: "week" }, { headers: CACHE_HEADERS });
}
