import { type NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";
import { requireSupabase } from "@/lib/supabase";
import { verifyAction } from "@/lib/feedback/auth";
import { getEligibility } from "@/lib/feedback/eligibility";
import { ensureProfile } from "@/lib/feedback/store";

export const runtime = "nodejs";

interface VoteBody {
  address?: string;
  nonce?: string;
  issuedAt?: string;
  signature?: string;
}

async function read(req: NextRequest): Promise<VoteBody | null> {
  try {
    return (await req.json()) as VoteBody;
  } catch {
    return null;
  }
}

// POST /api/feedback/[id]/vote  — upvote (idempotent, one per wallet)
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = await read(req);
  if (!p) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const { address, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({ address, action: "vote", subject: id, nonce, issuedAt, signature });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });

  const elig = await getEligibility(v.address);
  if (!elig.eligible) return NextResponse.json({ error: elig.reason ?? "not eligible" }, { status: 403 });

  const db = requireSupabase();
  await ensureProfile(v.address);
  const { data, error } = await db.rpc("cast_vote", { p_post_id: id, p_voter: v.address, p_sig: signature });
  if (error) return NextResponse.json({ error: "vote failed" }, { status: 500 });
  return NextResponse.json({ voteCount: data as number, hasVoted: true });
}

// DELETE /api/feedback/[id]/vote  — remove your upvote
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const p = await read(req);
  if (!p) return NextResponse.json({ error: "bad json" }, { status: 400 });
  const { address, nonce, issuedAt, signature } = p;
  if (!address || !isAddress(address)) return NextResponse.json({ error: "bad address" }, { status: 400 });
  if (!nonce || !issuedAt || !signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  const v = await verifyAction({ address, action: "unvote", subject: id, nonce, issuedAt, signature });
  if (!v.ok) return NextResponse.json({ error: v.error ?? "unauthorized" }, { status: 401 });

  const db = requireSupabase();
  const { data, error } = await db.rpc("remove_vote", { p_post_id: id, p_voter: v.address });
  if (error) return NextResponse.json({ error: "unvote failed" }, { status: 500 });
  return NextResponse.json({ voteCount: data as number, hasVoted: false });
}
