import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { isAdmin } from "@/lib/feedback/eligibility";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

interface Winner {
  postId?: string;
  amountEth?: number;
  rank?: number;
}
interface WinnerRow {
  round_id: string;
  post_id: string;
  rank: number;
  amount_eth: number;
  selected_by: string;
}
interface RewardsOpBody {
  address?: string;
  op?: "finalize" | "paid";
  nonce?: string;
  issuedAt?: string;
  signature?: string;
  // op: "finalize"
  winners?: Winner[];
  // op: "paid"
  postId?: string;
  txHash?: string;
}

// POST /api/admin/rewards/[round] — admin settles a round.
//   op:"finalize" { winners:[{postId, amountEth, rank}] } -> record winners, mark finalized
//   op:"paid"     { postId, txHash }                      -> record a winner's payout tx
export async function POST(req: NextRequest, ctx: { params: Promise<{ round: string }> }) {
  const { round } = await ctx.params;
  if (!UUID_RE.test(round)) return NextResponse.json({ error: "bad round id" }, { status: 400 });

  let p: RewardsOpBody;
  try {
    p = (await req.json()) as RewardsOpBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const { address, op, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (op !== "finalize" && op !== "paid") return NextResponse.json({ error: "bad op" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({
    address,
    action: "admin",
    subject: `rewards:${round}:${op}`,
    nonce,
    issuedAt,
    signature,
  });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });
  if (!isAdmin(v.address)) return NextResponse.json({ error: "not admin" }, { status: 403 });

  const db = requireSupabase();

  if (op === "finalize") {
    const winners = Array.isArray(p.winners) ? p.winners : [];
    if (winners.length === 0) return NextResponse.json({ error: "no winners" }, { status: 400 });

    const rows: WinnerRow[] = [];
    for (const w of winners) {
      if (!w.postId || !UUID_RE.test(w.postId))
        return NextResponse.json({ error: "bad winner postId" }, { status: 400 });
      const amount = Number(w.amountEth);
      if (!Number.isFinite(amount) || amount < 0)
        return NextResponse.json({ error: "bad winner amountEth" }, { status: 400 });
      const rank = Number(w.rank);
      if (!Number.isInteger(rank) || rank < 1)
        return NextResponse.json({ error: "bad winner rank" }, { status: 400 });
      rows.push({ round_id: round, post_id: w.postId, rank, amount_eth: amount, selected_by: v.address });
    }

    // Upsert so re-finalizing a round updates amounts/ranks instead of hard-failing
    // on the (round_id, post_id) primary key.
    const { error: winErr } = await db.from("reward_winners").upsert(rows, { onConflict: "round_id,post_id" });
    if (winErr) return NextResponse.json({ error: "finalize failed" }, { status: 500 });

    // Mark the round finalized. pot_eth keeps its open-time snapshot on purpose: the
    // fee scan is pinned to the CURRENT ISO week, so recomputing here (finalize runs
    // at/after week end) would sum the next week's ~0 fees and clobber the real figure.
    const { error: roundErr } = await db.from("reward_rounds").update({ status: "finalized" }).eq("id", round);
    if (roundErr) return NextResponse.json({ error: "finalize failed" }, { status: 500 });

    await db
      .from("admin_actions")
      .insert({ actor: v.address, action: `rewards:${round}:finalize`, target: round, signature });
    return NextResponse.json({ ok: true, winners: rows.length });
  }

  // op === "paid": record the payout tx hash for one winning post.
  const { postId, txHash } = p;
  if (!postId || !UUID_RE.test(postId)) return NextResponse.json({ error: "bad postId" }, { status: 400 });
  if (!txHash || !TX_RE.test(txHash)) return NextResponse.json({ error: "bad txHash" }, { status: 400 });

  const { data: updated, error } = await db
    .from("reward_winners")
    .update({ paid_tx: txHash })
    .eq("round_id", round)
    .eq("post_id", postId)
    .select("round_id, post_id, paid_tx");
  if (error) return NextResponse.json({ error: "paid update failed" }, { status: 500 });
  if (!updated || updated.length === 0) return NextResponse.json({ error: "winner not found" }, { status: 404 });

  await db
    .from("admin_actions")
    .insert({ actor: v.address, action: `rewards:${round}:paid`, target: postId, signature });
  return NextResponse.json({ ok: true });
}
