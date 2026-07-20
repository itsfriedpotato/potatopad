import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { issueNonce } from "@/lib/feedback/auth";

export const runtime = "nodejs";

// GET /api/feedback/nonce?address=0x... -> { nonce, issuedAt }
// The wallet signs a message containing this single-use nonce; the server burns it
// on verify (anti-replay).
export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  try {
    const nonce = await issueNonce(address);
    return NextResponse.json({ nonce, issuedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: "feedback unavailable" }, { status: 503 });
  }
}
