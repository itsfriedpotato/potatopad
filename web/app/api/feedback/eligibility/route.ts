import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { debugScan, getEligibility } from "@/lib/feedback/eligibility";

export const runtime = "nodejs";

// GET /api/feedback/eligibility?address=0x... -> EligibilityInfo
// ?debug=1 returns the engine's internal state (triage only).
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    if (req.nextUrl.searchParams.get("debug") === "1") {
      return NextResponse.json(await debugScan(address));
    }
    const info = await getEligibility(address);
    return NextResponse.json(info);
  } catch (e) {
    return NextResponse.json({ error: "feedback unavailable", detail: String(e).slice(0, 300) }, { status: 503 });
  }
}
