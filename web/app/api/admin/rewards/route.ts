import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { isAdmin } from "@/lib/feedback/eligibility";
import { currentIsoWeek, isoDate, potUsd } from "@/lib/feedback/rewards";

export const runtime = "nodejs";

// GET /api/admin/rewards — public: list reward rounds (newest first) with their
// winners, for the admin panel and a public rewards history.
export async function GET() {
  try {
    const db = requireSupabase();
    const { data, error } = await db
      .from("reward_rounds")
      .select(
        "id, week_start, week_end, pot_eth, status, created_at, reward_winners(post_id, rank, amount_eth, paid_tx, selected_by)",
      )
      .order("week_start", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ rounds: data ?? [] });
  } catch {
    return NextResponse.json({ rounds: [], unavailable: true });
  }
}

interface OpenBody {
  address?: string;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

// POST /api/admin/rewards — admin opens a new reward round for the CURRENT ISO week.
// pot_eth records the fixed weekly pot (USD) that applied when the round opened; the
// current pot is also served by GET /api/feedback/rewards.
export async function POST(req: NextRequest) {
  let p: OpenBody;
  try {
    p = (await req.json()) as OpenBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "admin",
    subject: "rewards:open",
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });
  if (!isAdmin(v.address)) return NextResponse.json({ error: "not admin" }, { status: 403 });

  const db = requireSupabase();
  const { weekStart, weekEnd } = currentIsoWeek();
  const weekStartDate = isoDate(weekStart);
  const weekEndDate = isoDate(weekEnd);

  // One round per ISO week: don't open a duplicate for the same week_start. This is a
  // best-effort guard (the schema has no unique constraint on week_start); limit(1)
  // keeps it from erroring if a duplicate ever slipped through.
  const { data: existing } = await db
    .from("reward_rounds")
    .select("id, status")
    .eq("week_start", weekStartDate)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: "round already open for this week", round: existing }, { status: 409 });
  }

  const pot = potUsd();
  const { data: round, error } = await db
    .from("reward_rounds")
    .insert({ week_start: weekStartDate, week_end: weekEndDate, pot_eth: pot, status: "open" })
    .select("id, week_start, week_end, pot_eth, status, created_at")
    .single();
  if (error || !round) return NextResponse.json({ error: "open failed" }, { status: 500 });

  await db
    .from("admin_actions")
    .insert({ actor: v.address, action: "rewards:open", target: round.id as string, signature });
  return NextResponse.json({ ok: true, round });
}
