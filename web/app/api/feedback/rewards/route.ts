import { NextResponse } from "next/server";
import { currentRound, potForWeekEth, REWARD_POLICY_PCT } from "@/lib/feedback/rewards";

export const runtime = "nodejs";

// The pot is 30-min cached and the round changes rarely, so let the edge hold it.
const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" };

// GET /api/feedback/rewards — public sidebar data: the open round, this week's pot
// (10% of treasury fees so far), and the policy percent. Each source degrades on its
// own so a Supabase blip does not zero the on-chain pot, and vice versa.
export async function GET() {
  const [roundRes, potRes] = await Promise.allSettled([currentRound(), potForWeekEth()]);
  const round = roundRes.status === "fulfilled" ? roundRes.value : null;
  const potEth = potRes.status === "fulfilled" ? potRes.value : 0;
  return NextResponse.json({ round, potEth, policyPct: REWARD_POLICY_PCT }, { headers: CACHE_HEADERS });
}
