// Scheduled snapshot endpoint for the feedback board's time-weighted eligibility.
//
// SCHEDULING: this route does not schedule itself. An external scheduler (Railway
// cron, GitHub Actions, cron-job.org, etc.) should POST it every 3 to 6 hours with
// the shared secret, for example:
//
//   curl -X POST https://<host>/api/feedback/cron \
//     -H "Authorization: Bearer $CRON_SECRET"
//
// GET works too (for schedulers that only issue GET), with the secret in the header
// or as ?secret=... CRON_SECRET must be set in the environment: .env.local in local
// dev and the Railway service variables in production. Without it the route returns
// 503 and does nothing.
import { type NextRequest, NextResponse } from "next/server";
import { runSnapshot, type SnapshotResult } from "@/lib/feedback/snapshot";

export const runtime = "nodejs";

const EMPTY: SnapshotResult = { ok: false, tokens: 0, wallets: 0 };

// 503 when the secret is not configured, 401 when it does not match, null when OK.
function denyStatus(req: NextRequest): number | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return 503;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const query = req.nextUrl.searchParams.get("secret") ?? "";
  return bearer === secret || query === secret ? null : 401;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const status = denyStatus(req);
  if (status !== null) {
    const error = status === 503 ? "cron not configured" : "unauthorized";
    return NextResponse.json({ ...EMPTY, error }, { status });
  }
  try {
    const result = await runSnapshot();
    return NextResponse.json(result);
  } catch {
    // runSnapshot is best-effort and should not throw; never 500 the scheduler.
    return NextResponse.json(EMPTY);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
