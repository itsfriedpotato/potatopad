import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { getEligibility } from "@/lib/feedback/eligibility";

export const runtime = "nodejs";

// GET /api/feedback/eligibility?address=0x... -> EligibilityInfo
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    const info = await getEligibility(address);
    return NextResponse.json(info);
  } catch {
    return NextResponse.json({ error: "feedback unavailable" }, { status: 503 });
  }
}
